use std::io::{self, Write};

use serde::Serialize;
use world_protocol::budget::BudgetDimension;

use super::WasmError;
use crate::extensions::invocation::CallBudget;

struct Counter {
    bytes: u64,
    maximum: u64,
    exceeded: bool,
}
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let total = self.bytes.checked_add(bytes.len() as u64);
        if total.is_none_or(|total| total > self.maximum) {
            self.exceeded = true;
            return Err(io::Error::other("world output byte budget exceeded"));
        }
        self.bytes = total.expect("checked byte count");
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Logical protocol bytes only; WIT encoding and Wasmtime lifting have separate limits.
pub(super) fn bytes(value: &impl Serialize, maximum: u64) -> Result<usize, WasmError> {
    let mut counter = Counter {
        bytes: 0,
        maximum,
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut counter, value);
    if counter.exceeded {
        return Err(crate::extensions::invocation::BudgetFailure {
            dimension: BudgetDimension::Bytes,
        }
        .into());
    }
    result.map_err(WasmError::Meter)?;
    usize::try_from(counter.bytes).map_err(|_| {
        crate::extensions::invocation::BudgetFailure {
            dimension: BudgetDimension::Bytes,
        }
        .into()
    })
}

pub(super) fn charge(
    budget: &CallBudget,
    value: &impl Serialize,
    maximum: u64,
) -> Result<usize, WasmError> {
    let bytes = bytes(value, maximum)?;
    budget.charge(BudgetDimension::Bytes, bytes as u64)?;
    Ok(bytes)
}
