use std::time::{Duration, Instant};

use wasm_host::{ExecutionError, ExecutionLimits, FailureKind, Stage};
use world_protocol::{budget::Budget, package::PackageLimits, time::DurationMs};

use super::WasmError;

#[derive(Clone, Copy)]
pub(crate) struct ExecutionPolicy {
    pub limits: ExecutionLimits,
    pub host_io_timeout: Duration,
    pub cleanup_timeout: Duration,
}

pub(super) struct EffectiveLimits {
    pub store: ExecutionLimits,
    pub budget: Budget,
    pub deadline: Instant,
    pub host_io_timeout: Duration,
    pub cleanup_timeout: Duration,
}

impl ExecutionPolicy {
    pub(super) fn intersect(
        &self,
        package: &PackageLimits,
        requested: &Budget,
    ) -> Result<EffectiveLimits, WasmError> {
        let invalid = || {
            WasmError::Execution(ExecutionError::new(
                Stage::Configure,
                FailureKind::InvalidLimit,
            ))
        };
        if self.limits.memories == 0
            || self.host_io_timeout.is_zero()
            || self.cleanup_timeout.is_zero()
        {
            return Err(invalid());
        }
        let mut budget = requested.clone();
        let cap = &package.budget;
        budget.max_wall_time = DurationMs(
            requested
                .max_wall_time
                .0
                .min(cap.max_wall_time.0)
                .min(package.call_timeout.0),
        );
        budget.max_steps = requested
            .max_steps
            .min(cap.max_steps)
            .min(package.fuel.unwrap_or(u64::MAX))
            .min(self.limits.fuel);
        budget.max_source_reads = requested.max_source_reads.min(cap.max_source_reads);
        budget.max_rows = requested.max_rows.min(cap.max_rows);
        budget.max_bytes = requested
            .max_bytes
            .min(cap.max_bytes)
            .min(package.maximum_frame_bytes)
            .min(self.limits.output_bytes as u64);
        budget.max_model_calls = requested.max_model_calls.min(cap.max_model_calls);
        budget.max_input_tokens = requested.max_input_tokens.min(cap.max_input_tokens);
        budget.max_output_tokens = requested.max_output_tokens.min(cap.max_output_tokens);
        budget.max_cost = match (&requested.max_cost, &cap.max_cost) {
            (Some(left), Some(right)) if left.currency != right.currency => {
                return Err(crate::extensions::invocation::BudgetFailure {
                    dimension: world_protocol::budget::BudgetDimension::Cost,
                }
                .into());
            }
            (Some(left), Some(right)) => Some(
                if left.amount.cmp_numeric(&right.amount).is_le() {
                    left
                } else {
                    right
                }
                .clone(),
            ),
            (left, right) => left.as_ref().or(right.as_ref()).cloned(),
        };
        budget.deadline = match (&requested.deadline, &cap.deadline) {
            (Some(left), Some(right)) => Some(left.min(right).clone()),
            (None, limit) | (limit, None) => limit.clone(),
        };
        let mut wall = Duration::from_millis(budget.max_wall_time.0);
        if let Some(deadline) = &budget.deadline {
            let remaining = deadline
                .unix_millis()
                .saturating_sub(chrono::Utc::now().timestamp_millis());
            wall = wall.min(Duration::from_millis(u64::try_from(remaining).unwrap_or(0)));
        }
        let deadline = Instant::now().checked_add(wall).ok_or_else(invalid)?;
        let mut store = self.limits;
        store.fuel = budget.max_steps;
        // The package's aggregate linear-memory allowance is conservatively
        // divided across the admitted memory count. This is not an RSS limit.
        store.memory_bytes_per_memory = store.memory_bytes_per_memory.min(
            usize::try_from(package.memory_bytes / store.memories as u64).unwrap_or(usize::MAX),
        );
        store.instances = store.instances.min(package.maximum_instances as usize);
        store.lift_bytes = store
            .lift_bytes
            .min(usize::try_from(budget.max_bytes).unwrap_or(usize::MAX));
        store.output_bytes = store
            .output_bytes
            .min(usize::try_from(budget.max_bytes).unwrap_or(usize::MAX));
        Ok(EffectiveLimits {
            store,
            budget,
            deadline,
            host_io_timeout: self.host_io_timeout,
            cleanup_timeout: self.cleanup_timeout,
        })
    }
}
