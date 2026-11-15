use super::{*, transaction::{ApprovalUndo, RunUndo}};
use crate::store::{StoreFault, content::ContentStore, records::{execution, run, team}, schema::{RecordChange, RecordKey, RecordKind}};

fn key(kind: RecordKind, scope: &str, id: &str) -> RecordKey {
    RecordKey { kind, scope: scope.to_owned(), id: id.to_owned() }
}

impl OrganizationFacts {
    pub(crate) fn changed_records(
        &self,
        contents: &ContentStore,
        transaction: &crate::store::sqlite::WriteTransaction<'_>,
    ) -> Result<Vec<RecordChange>, StoreFault> {
        self.validate_changed().map_err(|_| StoreFault::InvalidFacts)?;
        let mut changes = Vec::new();
        if self.journal.team_prompts.is_some() {
            changes.push(RecordChange::Put(crate::store::records::prompts::encode(&self.team_prompts)?));
        }
        for id in self.journal.teams.keys() {
            match self.teams.get(id) {
                Some(value) => changes.push(RecordChange::Put(team::encode_team(value)?)),
                None => changes.push(RecordChange::Delete(key(RecordKind::Team, "", id))),
            }
        }
        for id in self.journal.materializations.keys() {
            match self.materializations.get(id) {
                Some(value) => changes.push(RecordChange::Put(team::encode_materialization(value, contents)?)),
                None => changes.push(RecordChange::Delete(key(RecordKind::Materialization, "", id))),
            }
        }
        for id in self.journal.templates.keys() {
            match self.templates.get(id) {
                Some(value) => changes.push(RecordChange::Put(team::encode_template(value, contents)?)),
                None => changes.push(RecordChange::Delete(key(RecordKind::WorkflowTemplate, "", id))),
            }
        }
        for id in self.journal.admissions.keys() {
            match self.pending_workflow_plan_admissions.get(id) {
                Some(value) => changes.push(RecordChange::Put(team::encode_admission(value)?)),
                None => changes.push(RecordChange::Delete(key(RecordKind::WorkflowAdmission, "", id))),
            }
        }
        for id in self.journal.purged.keys() {
            match self.purged_runs.get(id) {
                Some(value) => changes.push(RecordChange::Put(team::encode_purged(value)?)),
                None => changes.push(RecordChange::Delete(key(RecordKind::PurgedRun, "", id))),
            }
        }
        for (id, undo) in &self.journal.runs {
            match (self.runs.get(id), undo) {
                (Some(value), RunUndo::Inserted) => changes.extend(run::encode_run(value, contents)?.into_iter().map(RecordChange::Put)),
                (Some(value), RunUndo::Updated(old)) => {
                    if value.team != old.team || value.frozen_team_revision != old.revision
                        || value.runtime != old.runtime || value.lifecycle != old.lifecycle || value.start_gate != old.start_gate
                        || value.retired_executions != old.retired_executions
                        || value.workspace != old.workspace
                        || value.role_session_intents != old.role_session_intents
                        || value.deletion_confirmations != old.deletion_confirmations
                    { changes.push(RecordChange::Put(run::encode_header(value)?)); }
                    changes.extend(run::encode_graph_changes(value, contents)?);
                }
                (Some(_), RunUndo::Removed(_)) => return Err(StoreFault::InvalidFacts),
                (None, RunUndo::Removed(old)) => {
                    changes.push(RecordChange::Delete(key(RecordKind::RunHeader, id, "")));
                    changes.push(RecordChange::Delete(key(RecordKind::GraphDefinition, id, "")));
                    for name in old.graph.metadata().keys() { changes.push(RecordChange::Delete(key(RecordKind::GraphMetadata, id, name.as_str()))); }
                    for node in old.graph.layout().node_positions().keys() { changes.push(RecordChange::Delete(key(RecordKind::NodePosition, id, node.as_str()))); }
                    for history in old.graph.executions().values() {
                        for attempt in history.attempts() { changes.push(RecordChange::Delete(key(RecordKind::Attempt, id, attempt.fence().node_execution_id().as_str()))); }
                    }
                    for item in old.graph.ready_queue() { changes.push(RecordChange::Delete(key(RecordKind::ReadyQueue, id, item.node_id().as_str()))); }
                }
                (None, _) => {}
            }
        }
        let mut execution_keys = Vec::new();
        execution_keys.extend(self.activities.changed_ids().map(|id| key(RecordKind::Activity, "", id.as_str())));
        execution_keys.extend(self.deliveries.changed_ids().map(|id| key(RecordKind::Delivery, "", id.as_str())));
        execution_keys.extend(self.evidence.changed_ids().map(|id| key(RecordKind::Evidence, "", id.as_str())));
        execution_keys.extend(self.artifacts.changed_ids().map(|id| key(RecordKind::Artifact, "", id.as_str())));
        execution_keys.extend(self.decisions.changed_ids().map(|(run, id)| key(RecordKind::Decision, run, id)));
        execution_keys.extend(self.decisions.changed_event_ids().map(|id| key(RecordKind::DecisionEvent, "", id)));
        for changed in self.task_board.changed_keys() {
            use crate::run::task_board::TaskBoardKey;
            let (kind, team, run, id) = match changed {
                TaskBoardKey::Task { team, run, id } => (RecordKind::Task, team, run, id),
                TaskBoardKey::Runner { team, run, id } => (RecordKind::Runner, team, run, id),
                TaskBoardKey::Mailbox { team, run, id } => (RecordKind::Mailbox, team, run, id),
            };
            execution_keys.push(key(kind, &execution::scoped_key(team, run), id));
        }
        for key in execution_keys {
            let record = match key.kind {
                RecordKind::Activity => {
                    let id = ActivityId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?;
                    self.activities.activity(&id).map(|value| {
                        let owner = self.runs.get(value.facts().run_id.as_str()).ok_or(StoreFault::InvalidFacts)?;
                        let previous = self.activities.previous(&id);
                        let record = if previous.is_some() { transaction.read_record(&key)? } else { None };
                        execution::encode_activity_change(owner.team(), value, previous, record.as_ref(), contents)
                    }).transpose()?
                }
                RecordKind::Delivery => {
                    let id = crate::DeliveryId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?;
                    self.deliveries.delivery(&id).map(|value| {
                        let team = TeamId::try_new(value.facts().team_id.clone()).map_err(|_| StoreFault::CorruptRecord)?;
                        let previous = self.deliveries.previous(&id);
                        let record = if previous.is_some() { transaction.read_record(&key)? } else { None };
                        execution::encode_delivery_change(&team, value, previous, record.as_ref(), contents)
                    }).transpose()?
                }
                RecordKind::Evidence => self.evidence
                    .evidence(&crate::EvidenceId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?)
                    .map(|value| {
                        let owner = self.runs.get(value.run_id()).ok_or(StoreFault::InvalidFacts)?;
                        execution::encode_evidence(owner.team(), value, contents)
                    }).transpose()?,
                RecordKind::Artifact => self.artifacts
                    .artifact(&crate::run::artifact::ArtifactId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?)
                    .map(|value| {
                        let owner = self.runs.get(value.run_id()).ok_or(StoreFault::InvalidFacts)?;
                        execution::encode_artifact(owner.team(), value, contents)
                    }).transpose()?,
                RecordKind::Decision => self.decisions.decision_by_id(&key.scope, &key.id)
                    .map(execution::encode_decision).transpose()?,
                RecordKind::DecisionEvent => self.decisions.event(&key.id)
                    .map(execution::encode_decision_event).transpose()?,
                RecordKind::Task | RecordKind::Runner | RecordKind::Mailbox => {
                    let (team, run) = execution::split_scope(&key.scope)?;
                    match key.kind {
                        RecordKind::Task => self.task_board.task_record(team, run, &key.id)
                            .map(|(ordinal, value)| execution::encode_task(ordinal, value, contents)).transpose()?,
                        RecordKind::Runner => self.task_board.runner_record(team, run, &key.id)
                            .map(|(ordinal, value)| execution::encode_runner(ordinal, value, contents)).transpose()?,
                        RecordKind::Mailbox => self.task_board.mailbox_record(team, run, &key.id)
                            .map(|(ordinal, value)| execution::encode_mailbox(ordinal, value, contents)).transpose()?,
                        _ => unreachable!(),
                    }
                }
                _ => return Err(StoreFault::InvalidFacts),
            };
            changes.push(match record {
                Some(record) => {
                    if record.key != key { return Err(StoreFault::InvalidFacts); }
                    RecordChange::Put(record)
                }
                None => RecordChange::Delete(key),
            });
        }
        for (run_id, id) in self.triggers.changed_keys() {
            changes.push(match self.triggers.request(run_id, id) {
                Some(value) => {
                    let run = self.runs.get(run_id).ok_or(StoreFault::InvalidFacts)?;
                    RecordChange::Put(run::encode_trigger(run.team(), value)?)
                }
                None => RecordChange::Delete(key(RecordKind::Trigger, run_id, id)),
            });
        }
        for id in self.control_resolutions.changed_keys() {
            changes.push(match self.control_resolutions.resolution(id) {
                Some(value) => {
                    let run = self.runs.get(value.graph_run_id().as_str()).ok_or(StoreFault::InvalidFacts)?;
                    RecordChange::Put(run::encode_control(run.team(), value)?)
                }
                None => RecordChange::Delete(key(RecordKind::ControlResolution, "", id)),
            });
        }
        for (id, undo) in &self.journal.approvals {
            match (self.approvals.get(id), undo) {
                (Some(value), _) => {
                    let owner = self.runs.get(&value.facts().run_id).ok_or(StoreFault::InvalidFacts)?;
                    changes.extend(run::encode_approval_changes(owner.team(), value, contents)?.into_iter().map(RecordChange::Put));
                }
                (None, ApprovalUndo::Removed(old)) => {
                    changes.push(RecordChange::Delete(key(RecordKind::Approval, id, "")));
                    for ordinal in 0..old.resolutions().len() {
                        changes.push(RecordChange::Delete(key(RecordKind::ApprovalResolution, id, &ordinal.to_string())));
                    }
                }
                (None, _) => {}
            }
        }
        for run_id in self.events.changed_runs() {
            if !self.runs.contains_key(run_id.as_str()) {
                for command in self.events.removed_commands(run_id) {
                    changes.push(RecordChange::Delete(key(RecordKind::Command, run_id.as_str(), command.command_id().as_str())));
                }
                for event in self.events.removed_events(run_id) {
                    changes.push(RecordChange::Delete(key(RecordKind::Event, run_id.as_str(), event.event_id())));
                }
            } else {
                let owner = self.runs.get(run_id.as_str()).ok_or(StoreFault::InvalidFacts)?;
                for command in self.events.new_commands(run_id) { changes.push(RecordChange::Put(run::encode_command(owner.team(), command, contents)?)); }
                for event in self.events.new_events(run_id) { changes.push(RecordChange::Put(run::encode_event(owner.team(), event)?)); }
            }
        }
        Ok(changes)
    }
}
