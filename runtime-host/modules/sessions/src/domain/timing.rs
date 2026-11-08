use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::model::{MAX_ITEMS, MAX_SAFE_INTEGER, valid_id};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTiming {
    pub run_id: String,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub input_message_id: Option<String>,
}

pub(super) fn valid_run_timing(timing: &RunTiming) -> bool {
    valid_id(&timing.run_id)
        && timing.started_at_ms <= MAX_SAFE_INTEGER
        && timing.ended_at_ms.is_none_or(|ended| ended <= MAX_SAFE_INTEGER && ended >= timing.started_at_ms)
        && timing.input_message_id.as_deref().is_none_or(valid_id)
}

pub(super) fn valid_run_timings(timings: &[RunTiming]) -> bool {
    let mut runs = HashSet::with_capacity(timings.len().min(MAX_ITEMS));
    timings.len() <= MAX_ITEMS
        && timings.iter().all(|timing| valid_run_timing(timing) && runs.insert(&timing.run_id))
}

fn merged_run_timing(existing: &RunTiming, timing: &RunTiming) -> RunTiming {
    let mut merged = if existing.ended_at_ms.is_some() && timing.ended_at_ms.is_none() {
        existing.clone()
    } else {
        timing.clone()
    };
    merged.started_at_ms = existing.started_at_ms.min(timing.started_at_ms);
    merged.input_message_id = merged.input_message_id.or_else(|| existing.input_message_id.clone())
        .or_else(|| timing.input_message_id.clone());
    merged
}

pub(super) fn merge_run_timings(timings: &mut Vec<RunTiming>, incoming: &[RunTiming]) {
    let incoming: Vec<_> = incoming.iter().map(|timing| {
        timings.iter().find(|known| known.run_id == timing.run_id)
            .map_or_else(|| timing.clone(), |known| merged_run_timing(known, timing))
    }).collect();
    for timing in &incoming {
        update_run_timing(timings, timing);
    }
}

pub(super) fn update_run_timing(timings: &mut Vec<RunTiming>, timing: &RunTiming) {
    if let Some(existing) = timings.iter_mut().find(|existing| existing.run_id == timing.run_id) {
        *existing = merged_run_timing(existing, timing);
    } else {
        if timings.len() == MAX_ITEMS {
            timings.remove(0);
        }
        timings.push(timing.clone());
    }
}
