pub(crate) mod execution;
pub(crate) mod prompts;
pub(crate) mod run;
pub(crate) mod team;

use std::collections::{BTreeMap, BTreeSet};

use super::{
    OrganizationFacts, StoreFault,
    content::ContentStore,
    facts::FactsRestoreInput,
    schema::{RecordKind, StoredRecord},
};
use crate::{
    ActivityLedger, DeliveryLedger, TeamDecisionLedger, TeamDecisionLedgerSnapshot,
    run::{TaskBoardFacts, event::EventLedgerSnapshot},
};
use execution::ExecutionRecord;
use team::TeamRecord;

// Cold startup and explicit offline import only; transactions encode their dirty records directly.
pub(crate) fn encode_all(
    facts: &OrganizationFacts,
    contents: &ContentStore,
) -> Result<Vec<StoredRecord>, StoreFault> {
    let mut records = vec![prompts::encode(facts.team_prompts())?];
    let run_teams = facts
        .runs()
        .map(|run| (run.run_id().as_str(), run.team()))
        .collect::<BTreeMap<_, _>>();
    let team_for_run = |run_id: &str| {
        run_teams
            .get(run_id)
            .copied()
            .ok_or(StoreFault::InvalidFacts)
    };
    for value in facts.teams() {
        records.push(team::encode_team(value)?);
    }
    for value in facts.materialization_groups() {
        records.push(team::encode_materialization(value, contents)?);
    }
    for value in facts.templates() {
        records.push(team::encode_template(value, contents)?);
    }
    for value in facts.pending_workflow_plan_admissions() {
        records.push(team::encode_admission(value)?);
    }
    for value in facts.purged_run_markers() {
        records.push(team::encode_purged(value)?);
    }
    for value in facts.runs() {
        records.extend(run::encode_run(value, contents)?);
    }
    for value in facts.triggers().requests() {
        records.push(run::encode_trigger(team_for_run(&value.run_id)?, value)?);
    }
    for value in facts.control_node_resolutions() {
        records.push(run::encode_control(
            team_for_run(value.graph_run_id().as_str())?,
            value,
        )?);
    }
    for value in facts.approvals() {
        records.extend(run::encode_approval(
            team_for_run(&value.facts().run_id)?,
            value,
            contents,
        )?);
    }
    let events = facts.event_snapshot();
    for value in events.commands() {
        records.push(run::encode_command(
            team_for_run(value.run_id().as_str())?,
            value,
            contents,
        )?);
    }
    for value in events.events() {
        records.push(run::encode_event(team_for_run(value.run_id())?, value)?);
    }
    for value in facts.activities().activities() {
        records.push(execution::encode_activity(
            team_for_run(value.facts().run_id.as_str())?,
            value,
            contents,
        )?);
    }
    for value in facts.deliveries().deliveries() {
        records.push(execution::encode_delivery(
            team_for_run(&value.facts().run_id)?,
            value,
            contents,
        )?);
    }
    for value in facts.evidence_records() {
        records.push(execution::encode_evidence(
            team_for_run(value.run_id())?,
            value,
            contents,
        )?);
    }
    for value in facts.artifacts() {
        records.push(execution::encode_artifact(
            team_for_run(value.run_id())?,
            value,
            contents,
        )?);
    }
    let mut decision_runs = BTreeSet::new();
    for value in facts.decisions() {
        records.push(execution::encode_decision(value)?);
        decision_runs.insert(value.run_id());
    }
    for run in decision_runs {
        for value in facts.decision_ledger().events_for_run(run) {
            records.push(execution::encode_decision_event(value)?);
        }
    }
    for (ordinal, value) in facts.task_board().ordered_tasks() {
        records.push(execution::encode_task(ordinal, value, contents)?);
    }
    for (ordinal, value) in facts.task_board().ordered_runners() {
        records.push(execution::encode_runner(ordinal, value, contents)?);
    }
    for (ordinal, value) in facts.task_board().ordered_mailbox() {
        records.push(execution::encode_mailbox(ordinal, value, contents)?);
    }
    Ok(records)
}

pub(crate) fn decode_all(
    records: &[StoredRecord],
    contents: &ContentStore,
) -> Result<OrganizationFacts, StoreFault> {
    let mut keys = BTreeSet::new();
    for record in records {
        if !keys.insert(&record.key) {
            return Err(StoreFault::CorruptRecord);
        }
    }
    let runs = run::restore_runs(records, contents)?;
    let run_teams = runs
        .iter()
        .map(|run| (run.run_id().as_str(), run.team().as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut teams = Vec::new();
    let mut materializations = Vec::new();
    let mut templates = Vec::new();
    let mut pending_workflow_plan_admissions = Vec::new();
    let mut purged_runs = Vec::new();
    let mut deliveries = Vec::new();
    let mut activities = Vec::new();
    let mut triggers = Vec::new();
    let mut control_resolutions = Vec::new();
    let mut commands = Vec::new();
    let mut events = Vec::new();
    let mut evidence = Vec::new();
    let mut artifacts = Vec::new();
    let mut decisions = Vec::new();
    let mut decision_events = Vec::new();
    let mut tasks = Vec::new();
    let mut runners = Vec::new();
    let mut mailbox = Vec::new();
    let mut team_prompts = crate::prompts::TeamPromptSettings::default();
    for record in records {
        if record.key.kind == RecordKind::TeamPrompts {
            team_prompts = prompts::decode(record)?;
            continue;
        }
        match record.key.kind {
            RecordKind::Team
            | RecordKind::Materialization
            | RecordKind::WorkflowTemplate
            | RecordKind::WorkflowAdmission
            | RecordKind::PurgedRun => {
                match team::decode(record, contents)? {
                    TeamRecord::Team(value) => teams.push(value),
                    TeamRecord::Materialization(value) => {
                        let team = value.team().cloned().ok_or(StoreFault::InvalidFacts)?;
                        materializations.push((team, value));
                    }
                    TeamRecord::WorkflowTemplate(value) => templates.push(value),
                    TeamRecord::WorkflowAdmission(value) => {
                        pending_workflow_plan_admissions.push(value)
                    }
                    TeamRecord::PurgedRun(value) => purged_runs.push(value),
                }
                continue;
            }
            _ => {}
        }
        if !matches!(
            record.key.kind,
            RecordKind::Task
                | RecordKind::Runner
                | RecordKind::Mailbox
                | RecordKind::Decision
                | RecordKind::DecisionEvent
        ) {
            let run_id = record.run_id.as_deref().ok_or(StoreFault::CorruptRecord)?;
            let team = run_teams
                .get(run_id)
                .copied()
                .ok_or(StoreFault::InvalidFacts)?;
            if record.team_id.as_deref() != Some(team) {
                return Err(StoreFault::InvalidFacts);
            }
        }
        match record.key.kind {
            RecordKind::RunHeader
            | RecordKind::GraphDefinition
            | RecordKind::GraphMetadata
            | RecordKind::NodePosition
            | RecordKind::Attempt
            | RecordKind::ReadyQueue
            | RecordKind::Approval
            | RecordKind::ApprovalResolution => {}
            RecordKind::Trigger => triggers.push(run::decode_trigger(record)?),
            RecordKind::ControlResolution => control_resolutions.push(run::decode_control(record)?),
            RecordKind::Command => commands.push(run::decode_command(record, contents)?),
            RecordKind::Event => events.push(run::decode_event(record)?),
            RecordKind::Activity
            | RecordKind::Delivery
            | RecordKind::Evidence
            | RecordKind::Artifact
            | RecordKind::Decision
            | RecordKind::DecisionEvent
            | RecordKind::Task
            | RecordKind::Runner
            | RecordKind::Mailbox => match execution::decode(record, contents)? {
                ExecutionRecord::Activity(value) => activities.push(value),
                ExecutionRecord::Delivery(value) => deliveries.push(value),
                ExecutionRecord::Evidence(value) => evidence.push(value),
                ExecutionRecord::Artifact(value) => artifacts.push(value),
                ExecutionRecord::Decision(value) => decisions.push(value),
                ExecutionRecord::DecisionEvent(value) => decision_events.push(value),
                ExecutionRecord::Task { ordinal, record } => tasks.push((ordinal, record)),
                ExecutionRecord::Runner { ordinal, record } => runners.push((ordinal, record)),
                ExecutionRecord::Mailbox { ordinal, record } => mailbox.push((ordinal, record)),
            },
            RecordKind::TeamPrompts => unreachable!("prompt settings were decoded above"),
            RecordKind::Team
            | RecordKind::Materialization
            | RecordKind::WorkflowTemplate
            | RecordKind::WorkflowAdmission
            | RecordKind::PurgedRun => unreachable!("team records were decoded above"),
        }
    }
    commands.sort_by(|left, right| {
        left.run_id()
            .cmp(right.run_id())
            .then(left.sequence().cmp(&right.sequence()))
    });
    events.sort_by(|left, right| {
        left.run_id()
            .cmp(right.run_id())
            .then(left.sequence().cmp(&right.sequence()))
    });
    let approvals = run::restore_approvals(records, contents)?;
    let task_board = TaskBoardFacts::restore_ordered(tasks, runners, mailbox)
        .map_err(|_| StoreFault::InvalidFacts)?;
    let deliveries = DeliveryLedger::from_restored(deliveries)
        .map_err(|_| StoreFault::InvalidFacts)?;
    let activities = ActivityLedger::from_restored(activities)
        .map_err(|_| StoreFault::InvalidFacts)?;
    let decisions = TeamDecisionLedger::restore(TeamDecisionLedgerSnapshot::from_durable(decisions, decision_events))
        .map_err(|_| StoreFault::InvalidFacts)?;
    OrganizationFacts::from_restored(FactsRestoreInput {
        teams,
        materializations,
        runs,
        pending_workflow_plan_admissions,
        templates,
        deliveries,
        activities,
        triggers,
        control_resolutions,
        approvals,
        events: EventLedgerSnapshot::from_durable(commands, events),
        evidence,
        decisions,
        artifacts,
        task_board,
        purged_runs,
        team_prompts,
    })
    .map_err(|_| StoreFault::InvalidFacts)
}
