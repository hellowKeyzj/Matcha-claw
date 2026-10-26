use super::{Error, numeric};
use std::cmp::Ordering;
use world_protocol::{
    budget::{Budget, BudgetDimension, Usage},
    evaluation::EvaluationFailure,
    time::{DurationMs, Timestamp},
};

pub(super) fn zero() -> Usage {
    Usage {
        elapsed: DurationMs(0),
        steps: 0,
        source_reads: 0,
        rows: 0,
        bytes: 0,
        model_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: None,
    }
}

pub(super) fn add(total: &mut Usage, usage: &Usage) -> Result<(), Error> {
    fn sum(left: &mut u64, right: u64) -> Result<(), Error> {
        *left = left
            .checked_add(right)
            .ok_or(EvaluationFailure::InternalFault)?;
        Ok(())
    }
    let unknown_cost = (total.model_calls > 0 && total.cost.is_none())
        || (usage.model_calls > 0 && usage.cost.is_none());
    sum(&mut total.elapsed.0, usage.elapsed.0)?;
    sum(&mut total.steps, usage.steps)?;
    sum(&mut total.source_reads, usage.source_reads)?;
    sum(&mut total.rows, usage.rows)?;
    sum(&mut total.bytes, usage.bytes)?;
    sum(&mut total.model_calls, usage.model_calls)?;
    sum(&mut total.input_tokens, usage.input_tokens)?;
    sum(&mut total.output_tokens, usage.output_tokens)?;
    if unknown_cost {
        total.cost = None;
        return Ok(());
    }
    match (&mut total.cost, &usage.cost) {
        (Some(total), Some(cost)) if total.currency == cost.currency => {
            total.amount = numeric::add(&total.amount, &cost.amount)
                .ok_or(EvaluationFailure::InternalFault)?;
        }
        (None, Some(cost)) => total.cost = Some(cost.clone()),
        (Some(_), Some(_)) => return Err(EvaluationFailure::InternalFault.into()),
        (_, None) => {}
    }
    Ok(())
}

pub(super) fn check(usage: &Usage, budget: &Budget, now: &Timestamp) -> Result<(), Error> {
    let dimensions = [
        (
            usage.elapsed.0,
            budget.max_wall_time.0,
            BudgetDimension::WallTime,
        ),
        (usage.steps, budget.max_steps, BudgetDimension::Steps),
        (
            usage.source_reads,
            budget.max_source_reads,
            BudgetDimension::SourceReads,
        ),
        (usage.rows, budget.max_rows, BudgetDimension::Rows),
        (usage.bytes, budget.max_bytes, BudgetDimension::Bytes),
        (
            usage.model_calls,
            budget.max_model_calls,
            BudgetDimension::ModelCalls,
        ),
        (
            usage.input_tokens,
            budget.max_input_tokens,
            BudgetDimension::InputTokens,
        ),
        (
            usage.output_tokens,
            budget.max_output_tokens,
            BudgetDimension::OutputTokens,
        ),
    ];
    for (used, maximum, dimension) in dimensions {
        if used > maximum {
            return Err(EvaluationFailure::BudgetExhausted { dimension }.into());
        }
    }
    if budget
        .deadline
        .as_ref()
        .is_some_and(|deadline| deadline <= now)
    {
        return Err(EvaluationFailure::BudgetExhausted {
            dimension: BudgetDimension::Deadline,
        }
        .into());
    }
    if let Some(maximum) = &budget.max_cost {
        match &usage.cost {
            Some(actual) if actual.currency != maximum.currency => {
                return Err(EvaluationFailure::InternalFault.into());
            }
            Some(actual)
                if numeric::compare(&actual.amount, &maximum.amount) == Ordering::Greater =>
            {
                return Err(EvaluationFailure::BudgetExhausted {
                    dimension: BudgetDimension::Cost,
                }
                .into());
            }
            None if usage.model_calls > 0 => return Err(EvaluationFailure::ExecutionFailed.into()),
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn within(inner: &Budget, outer: &Budget) -> bool {
    inner.max_wall_time <= outer.max_wall_time
        && inner.max_steps <= outer.max_steps
        && inner.max_source_reads <= outer.max_source_reads
        && inner.max_rows <= outer.max_rows
        && inner.max_bytes <= outer.max_bytes
        && inner.max_model_calls <= outer.max_model_calls
        && inner.max_input_tokens <= outer.max_input_tokens
        && inner.max_output_tokens <= outer.max_output_tokens
        && match (&inner.max_cost, &outer.max_cost) {
            (_, None) => true,
            (Some(inner), Some(outer)) => {
                inner.currency == outer.currency
                    && numeric::compare(&inner.amount, &outer.amount) != Ordering::Greater
            }
            (None, Some(_)) => false,
        }
        && match (&inner.deadline, &outer.deadline) {
            (_, None) => true,
            (Some(inner), Some(outer)) => inner <= outer,
            (None, Some(_)) => false,
        }
}

pub(super) fn now() -> Timestamp {
    Timestamp::try_new(chrono::Utc::now().to_rfc3339())
        .expect("UTC clock produces a valid timestamp")
}
