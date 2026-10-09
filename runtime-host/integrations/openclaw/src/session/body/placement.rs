use std::collections::HashMap;

use sessions_module::state::SessionItem;

use super::{Persisted, super::window::DisplayPosition};

pub(super) fn compose(items: &mut [SessionItem], messages: &[Persisted]) {
    let by_id = messages
        .iter()
        .map(|row| (row.id.as_str(), row.display_position()))
        .collect::<HashMap<_, _>>();
    let positions = items
        .iter()
        .map(|item| by_id.get(item.item_id()).copied().flatten())
        .collect::<Vec<_>>();
    let mut start = 0;
    while start < items.len() {
        let Some(first) = positions[start] else {
            start += 1;
            continue;
        };
        let mut end = start + 1;
        while end < items.len()
            && positions[end].is_some_and(|position| position.source == first.source)
        {
            end += 1;
        }
        let block = positions[start..end]
            .iter()
            .copied()
            .flatten()
            .collect::<Vec<_>>();
        compose_block(&mut items[start..end], &block);
        start = end;
    }
}

fn compose_block(items: &mut [SessionItem], positions: &[&DisplayPosition]) {
    let mut previous = None;
    let mut activities = Vec::new();
    for (index, position) in positions.iter().enumerate() {
        if position.activity.is_some() {
            activities.push(index);
        } else {
            if previous.is_some_and(|raw_seq| raw_seq > position.raw_seq) {
                return;
            }
            previous = Some(position.raw_seq);
        }
    }
    if activities.is_empty() {
        return;
    }
    activities.sort_by_key(|&index| {
        let position = positions[index];
        (
            position.activity.as_ref().unwrap().after_raw_seq,
            position.raw_seq,
        )
    });
    let mut ordered = Vec::with_capacity(items.len());
    let mut next = 0;
    for (index, position) in positions.iter().enumerate() {
        if position.activity.is_none() {
            emit_gap(
                &activities,
                &mut next,
                positions,
                Some(position.raw_seq),
                &mut ordered,
            );
            ordered.push(index);
        }
    }
    emit_gap(&activities, &mut next, positions, None, &mut ordered);
    let mut destinations = vec![0; items.len()];
    for (destination, original) in ordered.into_iter().enumerate() {
        destinations[original] = destination;
    }
    for index in 0..items.len() {
        while destinations[index] != index {
            let destination = destinations[index];
            items.swap(index, destination);
            destinations.swap(index, destination);
        }
    }
}

fn emit_gap(
    activities: &[usize],
    next: &mut usize,
    positions: &[&DisplayPosition],
    before_raw_seq: Option<u64>,
    ordered: &mut Vec<usize>,
) {
    let mut scopes = HashMap::new();
    let mut cohorts: Vec<(u64, Vec<usize>)> = Vec::new();
    while let Some(&index) = activities.get(*next) {
        let position = positions[index];
        let activity = position.activity.as_ref().unwrap();
        if before_raw_seq
            .is_some_and(|before| activity.after_raw_seq.is_some_and(|after| after >= before))
        {
            break;
        }
        let cohort = *scopes.entry(activity.scope_id.as_str()).or_insert_with(|| {
            cohorts.push((position.raw_seq, Vec::new()));
            cohorts.len() - 1
        });
        cohorts[cohort].0 = cohorts[cohort].0.min(position.raw_seq);
        cohorts[cohort].1.push(index);
        *next += 1;
    }
    cohorts.sort_by_key(|cohort| cohort.0);
    for (_, mut rows) in cohorts {
        rows.sort_by_key(|&index| {
            let position = positions[index];
            (
                position.activity.as_ref().unwrap().start_order,
                position.raw_seq,
            )
        });
        ordered.extend(rows);
    }
}
