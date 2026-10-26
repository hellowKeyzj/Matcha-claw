use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{ContextFailure, WorldView}, budget::{Budget, BudgetDimension},
    ids::DefinitionRef, learning::TaskContract,
    query::{QueryPage, Truncation, TruncationReason}, slots::ContextResult,
};
use crate::extensions::invocation::CallBudget;
use super::{Error, recall::Recalled};

/// Hard constraints and the original read receipt are never shortened to fit a prompt.
pub(super) fn assemble(
    task: &TaskContract, page: QueryPage, definitions: Vec<DefinitionRef>, recalled: Recalled, mut labels: Vec<String>,
    limit: &Budget, accounting: &CallBudget, cancellation: &CancellationToken,
) -> Result<ContextResult, Error> {
    if cancellation.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
    accounting.check().map_err(|_| ContextFailure::BudgetExceeded)?;
    if page.receipt.world != task.world { return Err(ContextFailure::BasisChanged.into()); }
    labels.extend(recalled.labels.clone());
    labels.sort(); labels.dedup();
    let receipt = page.receipt;
    let mut view = WorldView {
        world: task.world.clone(), task_id: task.id.clone(), task_revision: task.revision,
        scope: task.scope.clone(), goal: task.goal.clone(), hard_constraints: task.hard_constraints.clone(),
        allowed_effects: task.allowed_effects.clone(), stop_conditions: task.stop_conditions.clone(),
        rows: page.rows.items, objects: page.objects, relations: page.relations, definitions,
        actions: recalled.actions, abstractions: recalled.abstractions, labels, read_receipts: vec![receipt.clone()],
        truncation: receipt.truncation.clone(), untrusted_material: recalled.materials,
    };
    if page.rows.next_cursor.is_some() && view.truncation.is_none() {
        view.truncation = Some(Truncation { reason: TruncationReason::Rows, delivered: view.rows.len() as u64, limit: view.rows.len() as u64 });
    }
    let original = view.clone();
    let total = super::item_count(&view);
    let maximum = total.min(limit.max_rows).min(task.budget.max_rows);
    let byte_limit = limit.max_bytes.min(task.budget.max_bytes)
        .min(accounting.remaining(BudgetDimension::Bytes).map_err(|_| ContextFailure::BudgetExceeded)?);
    // UTF-8 bytes bound the byte-token payload conservatively; actual model usage stays with its owner.
    let token_limit = limit.max_input_tokens.min(task.budget.max_input_tokens)
        .min(accounting.remaining(BudgetDimension::InputTokens).map_err(|_| ContextFailure::BudgetExceeded)?);
    let capacity = byte_limit.min(token_limit);
    let reason = if maximum < total { TruncationReason::Rows }
        else if token_limit < byte_limit { TruncationReason::Tokens } else { TruncationReason::Bytes };
    let mut low = 0;
    let mut high = maximum;
    let mut accepted = None;
    while low <= high {
        if cancellation.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
        accounting.charge(BudgetDimension::Steps, 1).map_err(|_| ContextFailure::BudgetExceeded)?;
        let count = low + (high - low) / 2;
        prefix(&mut view, &original, count as usize);
        if count < total { view.truncation = Some(Truncation { reason, delivered: count, limit: if reason == TruncationReason::Rows { maximum } else { capacity } }); }
        let bytes = world_protocol::wire::encode(&view, usize::MAX).map_err(|_| ContextFailure::InternalFault)?;
        if bytes.len() as u64 <= capacity {
            accepted = Some((view.clone(), bytes.len() as u64));
            low = count + 1;
        } else {
            if count == 0 { break; }
            high = count - 1;
        }
    }
    let (view, bytes) = accepted.ok_or(ContextFailure::BudgetExceeded)?;
    if cancellation.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
    accounting.charge(BudgetDimension::Bytes, bytes).map_err(|_| ContextFailure::BudgetExceeded)?;
    Ok(ContextResult { view, receipt })
}

fn prefix(view: &mut WorldView, original: &WorldView, count: usize) {
    let rows = count.min(original.rows.len());
    let objects = (count - rows).min(original.objects.len());
    let relations = (count - rows - objects).min(original.relations.len());
    let actions = (count - rows - objects - relations).min(original.actions.len());
    let abstractions = (count - rows - objects - relations - actions).min(original.abstractions.len());
    let materials = (count - rows - objects - relations - actions - abstractions).min(original.untrusted_material.len());
    view.rows = original.rows[..rows].to_vec();
    view.objects = original.objects[..objects].to_vec();
    view.relations = original.relations[..relations].to_vec();
    view.actions = original.actions[..actions].to_vec();
    view.abstractions = original.abstractions[..abstractions].to_vec();
    view.untrusted_material = original.untrusted_material[..materials].to_vec();
    view.truncation = original.truncation.clone();
}
