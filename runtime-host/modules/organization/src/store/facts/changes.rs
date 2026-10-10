use super::{*, transaction::{ApprovalUndo, RunUndo}};
use crate::store::{StoreFault, content::ContentStore, records::{execution, run, team}, schema::{RecordChange, RecordKey, RecordKind}};

fn key(kind: RecordKind, scope: &str, id: &str) -> RecordKey {
    RecordKey { kind, scope: scope.to_owned(), id: id.to_owned() }
}

impl OrganizationFacts {
    pub(crate) fn changed_records(&self, contents: &ContentStore) -> Result<Vec<RecordChange>, StoreFault> {
        self.validate_changed().map_err(|_| StoreFault::InvalidFacts)?;
        let mut changes = Vec::new();
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
        execution_keys.extend(self.decisions.changed_decision_ids().map(|(run, id)| key(RecordKind::Decision, &run, &id)));
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
            changes.push(match execution::encode_key(self, &key, contents)? {
                Some(record) => RecordChange::Put(record), None => RecordChange::Delete(key),
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
