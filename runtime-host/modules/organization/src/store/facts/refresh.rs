use super::*;
use crate::store::{
    StoreFault,
    content::ContentStore,
    records::{
        execution::{self, ExecutionRecord},
        run,
        team::{self, TeamRecord},
    },
    schema::{RecordChange, RecordKey, RecordKind, StoredRecord},
};

impl OrganizationFacts {
    // A failed refresh invalidates the store handle; durable.rs requires a cold reload
    // before another operation. Imported records never replay business commands.
    pub(crate) fn apply_record_changes(
        &mut self,
        changes: Vec<RecordChange>,
        contents: &ContentStore,
    ) -> Result<(), StoreFault> {
        if changes.is_empty() {
            return Ok(());
        }
        let mut graphs: BTreeMap<String, Vec<RecordChange>> = BTreeMap::new();
        let mut puts = Vec::new();
        let mut deletes = Vec::new();
        for change in changes {
            let key = match &change {
                RecordChange::Put(record) => &record.key,
                RecordChange::Delete(key) => key,
            };
            if graph_record(key.kind) {
                graphs.entry(key.scope.clone()).or_default().push(change);
            } else {
                match change {
                    RecordChange::Put(record) => puts.push(record),
                    RecordChange::Delete(key) => deletes.push(key),
                }
            }
        }
        let mut replaced_approvals = BTreeSet::new();
        for record in &puts {
            match record.key.kind {
                RecordKind::Delivery => {
                    let id = crate::DeliveryId::new(&record.key.id)
                        .map_err(|_| StoreFault::CorruptRecord)?;
                    self.refresh_delivery_indexes(&id, None)
                        .map_err(|_| StoreFault::CorruptRecord)?;
                    self.deliveries.remove_record(&id);
                }
                RecordKind::Activity => {
                    let id =
                        ActivityId::new(&record.key.id).map_err(|_| StoreFault::CorruptRecord)?;
                    self.activities.remove_record(&id);
                }
                RecordKind::Decision => self
                    .decisions
                    .remove_decision(&record.key.scope, &record.key.id),
                RecordKind::DecisionEvent => self.decisions.remove_event(&record.key.id),
                RecordKind::Approval => {
                    let header = run::decode_approval_header(record)?;
                    if self
                        .approvals
                        .get(&header.facts.approval_id)
                        .is_some_and(|current| current.facts() != &header.facts)
                    {
                        self.approvals.remove(&header.facts.approval_id);
                        replaced_approvals.insert(record.key.scope.as_str());
                    }
                }
                RecordKind::Task | RecordKind::Runner | RecordKind::Mailbox => {
                    self.remove_persisted_record(&record.key)?;
                }
                _ => {}
            }
        }
        let deleted_approvals = deletes
            .iter()
            .filter(|key| key.kind == RecordKind::Approval)
            .map(|key| key.scope.as_str())
            .collect::<BTreeSet<_>>();
        let deleted_event_runs = deletes
            .iter()
            .filter(|key| matches!(key.kind, RecordKind::Command | RecordKind::Event))
            .map(|key| key.scope.as_str())
            .collect::<BTreeSet<_>>();
        for run_id in deleted_event_runs {
            self.events.retain_without_run(run_id);
        }
        for key in &deletes {
            if matches!(key.kind, RecordKind::Command | RecordKind::Event) {
                continue;
            }
            if key.kind == RecordKind::ApprovalResolution {
                if !deleted_approvals.contains(key.scope.as_str())
                    && !replaced_approvals.contains(key.scope.as_str())
                {
                    return Err(StoreFault::CorruptRecord);
                }
                continue;
            }
            self.remove_persisted_record(key)?;
        }
        for record in puts.iter().filter(|record| team_record(record.key.kind)) {
            match team::decode(record, contents)? {
                TeamRecord::Team(value) => {
                    self.teams
                        .insert(value.team_id().as_str().to_owned(), value);
                }
                TeamRecord::Materialization(value) => {
                    let key = value
                        .team()
                        .ok_or(StoreFault::CorruptRecord)?
                        .as_str()
                        .to_owned();
                    self.materializations.insert(key, value);
                }
                TeamRecord::WorkflowTemplate(value) => {
                    self.templates
                        .insert(value.team().as_str().to_owned(), value);
                }
                TeamRecord::WorkflowAdmission(value) => {
                    self.pending_workflow_plan_admissions
                        .insert(value.run_id().as_str().to_owned(), value);
                }
                TeamRecord::PurgedRun(value) => {
                    self.purged_runs
                        .insert(value.run_id().as_str().to_owned(), value);
                }
            }
        }
        for (run_id, changes) in graphs {
            if changes.iter().any(|change| {
                matches!(change,
                RecordChange::Delete(key) if key.kind == RecordKind::RunHeader)
            }) {
                if changes
                    .iter()
                    .any(|change| matches!(change, RecordChange::Put(_)))
                {
                    return Err(StoreFault::CorruptRecord);
                }
                self.events.retain_without_run(&run_id);
                self.runs.remove(&run_id);
            } else if let Some(current) = self.runs.get_mut(&run_id) {
                run::apply_changes(current, &changes, contents)?;
            } else {
                let records = changes
                    .into_iter()
                    .filter_map(|change| match change {
                        RecordChange::Put(record) => Some(record),
                        RecordChange::Delete(_) => None,
                    })
                    .collect::<Vec<_>>();
                if records.is_empty() {
                    continue;
                }
                let mut restored = run::restore_runs(&records, contents)?;
                if restored.len() != 1 || restored[0].run_id().as_str() != run_id {
                    return Err(StoreFault::CorruptRecord);
                }
                self.runs.insert(run_id, restored.remove(0));
            }
        }

        let mut resolutions = Vec::new();
        let mut commands = Vec::new();
        let mut events = Vec::new();
        let mut decisions = Vec::new();
        let mut decision_events = Vec::new();
        let mut tasks = Vec::new();
        let mut runners = Vec::new();
        let mut mailbox = Vec::new();
        for record in puts
            .into_iter()
            .filter(|record| !team_record(record.key.kind))
        {
            if !matches!(
                record.key.kind,
                RecordKind::Decision
                    | RecordKind::DecisionEvent
                    | RecordKind::Task
                    | RecordKind::Runner
                    | RecordKind::Mailbox
            ) {
                self.validate_record_owner(&record)?;
            }
            match record.key.kind {
                RecordKind::Trigger => self.triggers.import_record(run::decode_trigger(&record)?),
                RecordKind::ControlResolution => self
                    .control_resolutions
                    .import_record(run::decode_control(&record)?),
                RecordKind::Approval => {
                    let header = run::decode_approval_header(&record)?;
                    let approval = self
                        .approvals
                        .entry(header.facts.approval_id.clone())
                        .or_insert_with(|| Approval::request(header.facts.clone()));
                    approval
                        .import_header(header.facts, header.status)
                        .map_err(|_| StoreFault::CorruptRecord)?;
                }
                RecordKind::ApprovalResolution => {
                    resolutions.push(run::decode_approval_resolution(&record)?)
                }
                RecordKind::Command => commands.push(run::decode_command(&record, contents)?),
                RecordKind::Event => events.push(run::decode_event(&record)?),
                RecordKind::Activity
                | RecordKind::Delivery
                | RecordKind::Evidence
                | RecordKind::Artifact
                | RecordKind::Decision
                | RecordKind::DecisionEvent
                | RecordKind::Task
                | RecordKind::Runner
                | RecordKind::Mailbox => match execution::decode(&record, contents)? {
                    ExecutionRecord::Activity(value) => self
                        .activities
                        .restore_record(value)
                        .map_err(|_| StoreFault::CorruptRecord)?,
                    ExecutionRecord::Delivery(value) => {
                        self.refresh_delivery_indexes(&value.facts().delivery_id, Some(&value))
                            .map_err(|_| StoreFault::CorruptRecord)?;
                        self.deliveries
                            .restore_record(value)
                            .map_err(|_| StoreFault::CorruptRecord)?;
                    }
                    ExecutionRecord::Evidence(value) => self.evidence.restore_record(value),
                    ExecutionRecord::Artifact(value) => self.artifacts.restore_record(value),
                    ExecutionRecord::Decision(value) => decisions.push(value),
                    ExecutionRecord::DecisionEvent(value) => decision_events.push(value),
                    ExecutionRecord::Task { ordinal, record } => tasks.push((ordinal, record)),
                    ExecutionRecord::Runner { ordinal, record } => runners.push((ordinal, record)),
                    ExecutionRecord::Mailbox { ordinal, record } => mailbox.push((ordinal, record)),
                },
                _ => return Err(StoreFault::CorruptRecord),
            }
        }
        resolutions.sort_by(|left, right| {
            left.approval_id
                .cmp(&right.approval_id)
                .then(left.ordinal.cmp(&right.ordinal))
        });
        for entry in resolutions {
            let approval = self
                .approvals
                .get_mut(&entry.approval_id)
                .ok_or(StoreFault::CorruptRecord)?;
            if approval.facts().run_id != entry.run_id.as_str() {
                return Err(StoreFault::CorruptRecord);
            }
            approval
                .import_resolution(entry.ordinal, entry.resolution)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        commands.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for command in commands {
            self.events
                .import_command(command)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        events.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for event in events {
            self.events
                .import_event(event)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        decisions.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for decision in decisions {
            self.decisions
                .restore_decision(decision)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        decision_events.sort_by(|left, right| {
            left.run_id()
                .cmp(right.run_id())
                .then(left.sequence().cmp(&right.sequence()))
        });
        for event in decision_events {
            self.decisions
                .restore_event(event)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        tasks.sort_by_key(|(ordinal, _)| *ordinal);
        for (ordinal, record) in tasks {
            self.task_board
                .restore_task(ordinal, record)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        runners.sort_by_key(|(ordinal, _)| *ordinal);
        for (ordinal, record) in runners {
            self.task_board
                .restore_runner(ordinal, record)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        mailbox.sort_by_key(|(ordinal, _)| *ordinal);
        for (ordinal, record) in mailbox {
            self.task_board
                .restore_mailbox(ordinal, record)
                .map_err(|_| StoreFault::CorruptRecord)?;
        }
        Ok(())
    }

    fn validate_record_owner(&self, record: &StoredRecord) -> Result<(), StoreFault> {
        let run = record
            .run_id
            .as_deref()
            .and_then(|id| self.runs.get(id))
            .ok_or(StoreFault::CorruptRecord)?;
        if record.team_id.as_deref() != Some(run.team().as_str()) {
            return Err(StoreFault::CorruptRecord);
        }
        Ok(())
    }

    fn remove_persisted_record(&mut self, key: &RecordKey) -> Result<(), StoreFault> {
        match key.kind {
            RecordKind::Team => {
                self.teams.remove(&key.id);
            }
            RecordKind::Materialization => {
                self.materializations.remove(&key.id);
            }
            RecordKind::WorkflowTemplate => {
                self.templates.remove(&key.id);
            }
            RecordKind::WorkflowAdmission => {
                self.pending_workflow_plan_admissions.remove(&key.id);
            }
            RecordKind::PurgedRun => {
                self.purged_runs.remove(&key.id);
            }
            RecordKind::Approval => {
                self.approvals.remove(&key.scope);
            }
            RecordKind::Trigger => self.triggers.remove_record(&key.scope, &key.id),
            RecordKind::ControlResolution => self.control_resolutions.remove_record(&key.id),
            RecordKind::Activity => self
                .activities
                .remove_record(&ActivityId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?),
            RecordKind::Delivery => {
                let id = crate::DeliveryId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?;
                self.refresh_delivery_indexes(&id, None)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                self.deliveries.remove_record(&id);
            }
            RecordKind::Evidence => self.evidence.remove_record(
                &crate::EvidenceId::new(&key.id).map_err(|_| StoreFault::CorruptRecord)?,
            ),
            RecordKind::Artifact => self.artifacts.remove_record(
                &crate::run::artifact::ArtifactId::new(&key.id)
                    .map_err(|_| StoreFault::CorruptRecord)?,
            ),
            RecordKind::Decision => self.decisions.remove_decision(&key.scope, &key.id),
            RecordKind::DecisionEvent => self.decisions.remove_event(&key.id),
            RecordKind::Task | RecordKind::Runner | RecordKind::Mailbox => {
                let (team, run) = task_scope(&key.scope)?;
                match key.kind {
                    RecordKind::Task => self.task_board.remove_task(team, run, &key.id),
                    RecordKind::Runner => self.task_board.remove_runner(team, run, &key.id),
                    RecordKind::Mailbox => self.task_board.remove_mailbox(team, run, &key.id),
                    _ => unreachable!(),
                }
            }
            _ => return Err(StoreFault::CorruptRecord),
        }
        Ok(())
    }
}

fn graph_record(kind: RecordKind) -> bool {
    matches!(
        kind,
        RecordKind::RunHeader
            | RecordKind::GraphDefinition
            | RecordKind::GraphMetadata
            | RecordKind::NodePosition
            | RecordKind::Attempt
            | RecordKind::ReadyQueue
    )
}

fn team_record(kind: RecordKind) -> bool {
    matches!(
        kind,
        RecordKind::Team
            | RecordKind::Materialization
            | RecordKind::WorkflowTemplate
            | RecordKind::WorkflowAdmission
            | RecordKind::PurgedRun
    )
}

fn task_scope(scope: &str) -> Result<(&str, &str), StoreFault> {
    let (length, identity) = scope.split_once(':').ok_or(StoreFault::CorruptRecord)?;
    let length = length
        .parse::<usize>()
        .map_err(|_| StoreFault::CorruptRecord)?;
    identity
        .split_at_checked(length)
        .ok_or(StoreFault::CorruptRecord)
}
