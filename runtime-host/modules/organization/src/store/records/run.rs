mod approvals;
mod attempt;
mod control;
mod definition;
mod events;
mod header;

pub(crate) use approvals::{ApprovalHeader, ApprovalResolutionRecord, decode_approval_header, decode_approval_resolution, encode_approval, encode_approval_changes, restore_approvals};
pub(crate) use control::{decode_control, decode_trigger, encode_control, encode_trigger};
pub(crate) use events::{decode_command, decode_event, encode_command, encode_event};
pub(crate) use header::{RunHeader, decode_header, encode_header};

use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use crate::{
    GraphRunFacts, GraphRunId, TeamId,
    run::{event::{MetadataValue, OpaqueId}, graph::{GraphLayout, GraphState, NodeExecutionHistory, NodeId, NodePosition}},
    store::{StoreFault, content::ContentStore, schema::{RecordChange, RecordKey, RecordKind, StoredRecord}},
};
use attempt::{decode_attempt, decode_ready, encode_attempt, encode_ready};
use definition::{decode_definition, encode_definition};

fn record<T: Serialize>(team: &TeamId, run: &GraphRunId, kind: RecordKind, id: &str, value: &T) -> Result<StoredRecord, StoreFault> {
    Ok(StoredRecord {
        key: key(kind, run, id), team_id: Some(team.as_str().to_owned()), run_id: Some(run.as_str().to_owned()),
        payload: serde_json::to_vec(value).map_err(|_| StoreFault::InvalidFacts)?,
    })
}
fn key(kind: RecordKind, run: &GraphRunId, id: &str) -> RecordKey {
    RecordKey { kind, scope: run.as_str().to_owned(), id: id.to_owned() }
}
fn decode<T: DeserializeOwned>(row: &StoredRecord, kind: RecordKind) -> Result<T, StoreFault> {
    if row.key.kind != kind || row.team_id.is_none() || row.run_id.is_none() { return Err(StoreFault::InvalidFacts); }
    serde_json::from_slice(&row.payload).map_err(|_| StoreFault::InvalidFacts)
}

#[derive(Serialize, Deserialize)]
enum Metadata { Enabled(bool), Revision(u64), OpaqueId(String) }
fn encode_metadata(value: &MetadataValue) -> Metadata {
    match value { MetadataValue::Enabled(value) => Metadata::Enabled(*value), MetadataValue::Revision(value) => Metadata::Revision(*value), MetadataValue::OpaqueId(value) => Metadata::OpaqueId(value.as_str().to_owned()) }
}
fn decode_metadata(row: &StoredRecord) -> Result<MetadataValue, StoreFault> {
    Ok(match decode(row, RecordKind::GraphMetadata)? {
        Metadata::Enabled(value) => MetadataValue::Enabled(value), Metadata::Revision(value) => MetadataValue::Revision(value),
        Metadata::OpaqueId(value) => MetadataValue::OpaqueId(OpaqueId::try_new(value).map_err(|_| StoreFault::InvalidFacts)?),
    })
}
fn definition_record(run: &GraphRunFacts, contents: &ContentStore) -> Result<StoredRecord, StoreFault> {
    Ok(StoredRecord { key: key(RecordKind::GraphDefinition, run.run_id(), ""), team_id: Some(run.team().as_str().to_owned()), run_id: Some(run.run_id().as_str().to_owned()), payload: encode_definition(run.team(), run.run_id(), run.graph().definition(), contents)? })
}

pub(crate) fn encode_run(run: &GraphRunFacts, contents: &ContentStore) -> Result<Vec<StoredRecord>, StoreFault> {
    let mut rows = vec![encode_header(run)?, definition_record(run, contents)?];
    for (id, value) in run.graph().metadata() {
        rows.push(record(run.team(), run.run_id(), RecordKind::GraphMetadata, id.as_str(), &encode_metadata(value))?);
    }
    for (id, value) in run.graph().layout().node_positions() {
        rows.push(record(run.team(), run.run_id(), RecordKind::NodePosition, id.as_str(), &(value.x(), value.y()))?);
    }
    for history in run.graph().executions().values() {
        for attempt in history.attempts() { rows.push(encode_attempt(run.team(), run.run_id(), attempt)?); }
    }
    for item in run.graph().ready_queue() { rows.push(encode_ready(run.team(), run.run_id(), item)?); }
    Ok(rows)
}

pub(crate) fn encode_graph_changes(run: &GraphRunFacts, contents: &ContentStore) -> Result<Vec<RecordChange>, StoreFault> {
    let graph = run.graph();
    let Some(changes) = graph.changes() else { return Ok(Vec::new()) };
    let mut rows = BTreeMap::new();
    let mut put = |row: StoredRecord| { rows.insert(row.key.clone(), RecordChange::Put(row)); };
    if changes.definition { put(definition_record(run, contents)?); }
    for id in &changes.metadata {
        if let Some(value) = graph.metadata().get(id) { put(record(run.team(), run.run_id(), RecordKind::GraphMetadata, id.as_str(), &encode_metadata(value))?); }
    }
    for id in &changes.layout {
        if let Some(value) = graph.layout().node_positions().get(id) { put(record(run.team(), run.run_id(), RecordKind::NodePosition, id.as_str(), &(value.x(), value.y()))?); }
    }
    for (node, number) in &changes.attempts {
        if let Some(attempt) = graph.executions().get(node).and_then(|history| history.attempts().get(*number as usize - 1)) {
            put(encode_attempt(run.team(), run.run_id(), attempt)?);
        }
    }
    for node in &changes.ready {
        if let Some(item) = graph.ready_queue().iter().find(|item| item.node_id() == node) { put(encode_ready(run.team(), run.run_id(), item)?); }
    }
    for id in &changes.metadata {
        if !graph.metadata().contains_key(id) { let key = key(RecordKind::GraphMetadata, run.run_id(), id.as_str()); rows.insert(key.clone(), RecordChange::Delete(key)); }
    }
    for node in &changes.layout {
        if !graph.layout().node_positions().contains_key(node) { let key = key(RecordKind::NodePosition, run.run_id(), node.as_str()); rows.insert(key.clone(), RecordChange::Delete(key)); }
    }
    for node in &changes.ready {
        if !graph.ready_queue().iter().any(|item| item.node_id() == node) { let key = key(RecordKind::ReadyQueue, run.run_id(), node.as_str()); rows.insert(key.clone(), RecordChange::Delete(key)); }
    }
    for attempt in graph.removed_attempts() {
        let key = key(RecordKind::Attempt, run.run_id(), attempt.fence().node_execution_id().as_str());
        rows.entry(key.clone()).or_insert(RecordChange::Delete(key));
    }
    Ok(rows.into_values().collect())
}

fn graph_kind(kind: RecordKind) -> bool {
    matches!(kind, RecordKind::RunHeader | RecordKind::GraphDefinition | RecordKind::GraphMetadata | RecordKind::NodePosition | RecordKind::Attempt | RecordKind::ReadyQueue)
}

pub(crate) fn restore_runs(records: &[StoredRecord], contents: &ContentStore) -> Result<Vec<GraphRunFacts>, StoreFault> {
    let mut groups = BTreeMap::<&str, Vec<&StoredRecord>>::new();
    let mut keys = BTreeSet::new();
    for row in records.iter().filter(|row| graph_kind(row.key.kind)) {
        if !keys.insert(&row.key) { return Err(StoreFault::InvalidFacts); }
        groups.entry(row.key.scope.as_str()).or_default().push(row);
    }
    groups.into_values().map(|rows| {
        let header = decode_header(rows.iter().find(|row| row.key.kind == RecordKind::RunHeader).ok_or(StoreFault::InvalidFacts)?)?;
        let definition = rows.iter().find(|row| row.key.kind == RecordKind::GraphDefinition).ok_or(StoreFault::InvalidFacts)?;
        if !definition.key.id.is_empty() { return Err(StoreFault::InvalidFacts); }
        let definition = decode_definition(&header.team, &header.run, &definition.payload, contents)?;
        if definition.run_id() != &header.run { return Err(StoreFault::InvalidFacts); }
        let mut metadata = BTreeMap::new();
        let mut positions = BTreeMap::new();
        let mut attempts = BTreeMap::<NodeId, Vec<_>>::new();
        let mut ready = Vec::new();
        for row in rows {
            if row.team_id.as_deref() != Some(header.team.as_str()) || row.run_id.as_deref() != Some(header.run.as_str()) { return Err(StoreFault::InvalidFacts); }
            match row.key.kind {
                RecordKind::RunHeader | RecordKind::GraphDefinition if !row.key.id.is_empty() => return Err(StoreFault::InvalidFacts),
                RecordKind::GraphMetadata => { metadata.insert(OpaqueId::try_new(&row.key.id).map_err(|_| StoreFault::InvalidFacts)?, decode_metadata(row)?); }
                RecordKind::NodePosition => { let (x, y) = decode(row, RecordKind::NodePosition)?; positions.insert(NodeId::new(&row.key.id), NodePosition::new(x, y)); }
                RecordKind::Attempt => { let attempt = decode_attempt(row)?; attempts.entry(attempt.node_id().clone()).or_default().push(attempt); }
                RecordKind::ReadyQueue => ready.push(decode_ready(row)?),
                _ => {}
            }
        }
        let executions = attempts.into_iter().map(|(node, mut attempts)| {
            attempts.sort_by_key(|attempt| attempt.number());
            (node, NodeExecutionHistory::from_durable(attempts))
        }).collect();
        ready.sort_by(|left, right| left.enqueued_at().cmp(&right.enqueued_at()).then_with(|| left.node_id().cmp(right.node_id())));
        let graph = GraphState::from_durable(definition, metadata, GraphLayout::from_durable(positions), executions, ready);
        let graph = GraphState::restore_durable(graph.durable_snapshot()).map_err(|_| StoreFault::InvalidFacts)?;
        GraphRunFacts::with_lifecycle_and_start_gate(header.team, header.revision, graph, header.runtime, header.lifecycle, header.gate).map_err(|_| StoreFault::InvalidFacts)
    }).collect()
}

pub(crate) fn apply_changes(run: &mut GraphRunFacts, changes: &[RecordChange], contents: &ContentStore) -> Result<(), StoreFault> {
    let mut attempts = Vec::new();
    for change in changes {
        let record_key = match change { RecordChange::Put(row) => &row.key, RecordChange::Delete(key) => key };
        if !graph_kind(record_key.kind) || record_key.scope != run.run_id().as_str() { return Err(StoreFault::InvalidFacts); }
        match change {
            RecordChange::Put(row) => {
                if row.team_id.as_deref() != Some(run.team().as_str()) || row.run_id.as_deref() != Some(run.run_id().as_str()) { return Err(StoreFault::InvalidFacts); }
                match row.key.kind {
                    RecordKind::RunHeader => {
                        let header = decode_header(row)?;
                        run.replace_header(header.team, header.revision, header.runtime, header.lifecycle, header.gate);
                    }
                    RecordKind::GraphDefinition => {
                        if !row.key.id.is_empty() { return Err(StoreFault::InvalidFacts); }
                        let definition = decode_definition(run.team(), run.run_id(), &row.payload, contents)?;
                        if definition.run_id() != run.run_id() { return Err(StoreFault::InvalidFacts); }
                        run.graph_mut().import_definition(definition);
                    }
                    RecordKind::GraphMetadata => run.graph_mut().import_metadata(OpaqueId::try_new(&row.key.id).map_err(|_| StoreFault::InvalidFacts)?, Some(decode_metadata(row)?)),
                    RecordKind::NodePosition => { let (x, y) = decode(row, RecordKind::NodePosition)?; run.graph_mut().import_position(NodeId::new(&row.key.id), Some(NodePosition::new(x, y))); }
                    RecordKind::Attempt => attempts.push(decode_attempt(row)?),
                    RecordKind::ReadyQueue => { let ready = decode_ready(row)?; let node = ready.node_id().clone(); run.graph_mut().import_ready(&node, Some(ready)); }
                    _ => unreachable!(),
                }
            }
            RecordChange::Delete(key) => match key.kind {
                RecordKind::GraphMetadata => run.graph_mut().import_metadata(OpaqueId::try_new(&key.id).map_err(|_| StoreFault::InvalidFacts)?, None),
                RecordKind::NodePosition => run.graph_mut().import_position(NodeId::new(&key.id), None),
                RecordKind::Attempt => run.graph_mut().remove_attempt_record(&key.id),
                RecordKind::ReadyQueue => run.graph_mut().import_ready(&NodeId::new(&key.id), None),
                _ => return Err(StoreFault::InvalidFacts),
            }
        }
    }
    attempts.sort_by(|left, right| left.node_id().cmp(right.node_id()).then_with(|| left.number().cmp(&right.number())));
    for attempt in attempts { run.graph_mut().import_attempt(attempt).map_err(|_| StoreFault::InvalidFacts)?; }
    Ok(())
}
