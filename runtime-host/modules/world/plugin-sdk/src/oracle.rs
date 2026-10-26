use crate::protocol::{
    api::{PackageConfigView, package_config_digest},
    budget::BudgetDimension,
    evaluation::oracle,
    slots::{OracleFailure, OracleRequest, OracleResult},
    value::Value,
};

pub(crate) fn enabled(config: &PackageConfigView) -> Result<bool, OracleFailure> {
    if package_config_digest(&config.fields).map_err(|_| OracleFailure::SchemaMismatch)?
        != config.digest
        || config.fields.len() != 1
    {
        return Err(OracleFailure::SchemaMismatch);
    }
    match &config.fields[0] {
        crate::protocol::api::ConfigValue {
            name,
            value: Value::Boolean { value },
        } if name == "enabled" => Ok(*value),
        _ => Err(OracleFailure::SchemaMismatch),
    }
}

pub(crate) async fn evaluate_cancellable(
    request: OracleRequest,
    cancellation: tokio::sync::watch::Receiver<bool>,
) -> Result<OracleResult, OracleFailure> {
    let mut remaining = request.budget.max_wall_time.0;
    if let Some(deadline) = &request.budget.deadline {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| OracleFailure::BudgetExceeded)?.as_millis();
        let absolute = u128::try_from(deadline.unix_millis())
            .map_err(|_| OracleFailure::BudgetExceeded)?;
        let available = absolute.checked_sub(now).ok_or(OracleFailure::BudgetExceeded)?;
        remaining = remaining.min(available.min(u64::MAX as u128) as u64);
    }
    let deadline = tokio::time::Instant::now()
        .checked_add(std::time::Duration::from_millis(remaining))
        .ok_or(OracleFailure::BudgetExceeded)?;
    let mut usage = [0_u64; 3];
    oracle::evaluate(&request, || async {
        tokio::task::yield_now().await;
        if *cancellation.borrow() {
            Err(OracleFailure::Cancelled)
        } else if tokio::time::Instant::now() >= deadline {
            Err(OracleFailure::BudgetExceeded)
        } else {
            Ok(())
        }
    }, |dimension, amount| {
        let (index, limit) = match dimension {
            BudgetDimension::Steps => (0, request.budget.max_steps),
            BudgetDimension::Rows => (1, request.budget.max_rows),
            BudgetDimension::Bytes => (2, request.budget.max_bytes),
            _ => return Err(OracleFailure::SchemaMismatch),
        };
        usage[index] = usage[index].checked_add(amount)
            .filter(|total| *total <= limit).ok_or(OracleFailure::BudgetExceeded)?;
        Ok(())
    }).await
}
