use std::sync::Arc;

use diagnostics_module::{RuntimeStartupDiagnostic, RuntimeStartupDiagnostics};
use runtime_directory::{RuntimeControlFailure, RuntimeLogEntry, RuntimeLogSnapshot};
use serde_json::Value;

use crate::lifecycle::output::StartupDiagnosticCategory;

pub const fn runtime_startup_diagnostic(
    category: StartupDiagnosticCategory,
) -> RuntimeStartupDiagnostic {
    match category {
        StartupDiagnosticCategory::PortConflict => RuntimeStartupDiagnostic::PortConflict,
        StartupDiagnosticCategory::ConfigurationRejected => {
            RuntimeStartupDiagnostic::ConfigurationRejected
        }
        StartupDiagnosticCategory::AppServerReportedError => {
            RuntimeStartupDiagnostic::AppServerReportedError
        }
        StartupDiagnosticCategory::UnclassifiedStderr => {
            RuntimeStartupDiagnostic::UnclassifiedStderr
        }
        StartupDiagnosticCategory::InvalidUtf8 => RuntimeStartupDiagnostic::InvalidUtf8,
        StartupDiagnosticCategory::LineTooLong => RuntimeStartupDiagnostic::LineTooLong,
    }
}

pub(crate) fn project_logs(
    response: Value,
    after_id: u64,
) -> Result<RuntimeLogSnapshot, RuntimeControlFailure> {
    let items = response["items"]
        .as_array()
        .ok_or(RuntimeControlFailure::Unknown)?;
    let mut entries = Vec::with_capacity(items.len().min(100));
    let mut cursor = after_id;
    for item in items.iter().take(100) {
        let id = item["id"]
            .as_u64()
            .filter(|id| *id > cursor)
            .ok_or(RuntimeControlFailure::Unknown)?;
        let label = |name: &str| {
            item[name]
                .as_str()
                .filter(|label| {
                    !label.is_empty()
                        && label.len() <= 96
                        && label.as_bytes()[0].is_ascii_alphabetic()
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                })
                .ok_or(RuntimeControlFailure::Unknown)
        };
        let owner = label("owner")?;
        let operation = label("operation")?;
        let kind = label("kind")?;
        // Only native classification fields cross the product seam; context is private.
        entries.push(RuntimeLogEntry {
            source: "matcha-agent",
            line: format!("{owner}.{operation}: {kind}"),
        });
        cursor = id;
    }
    Ok(RuntimeLogSnapshot {
        entries,
        cursor,
        reset: false,
        truncated: items.len() > 100,
        lifecycle_tail_evicted: false,
    })
}

pub fn runtime_diagnostic_reporter(
    diagnostics: RuntimeStartupDiagnostics,
) -> Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync> {
    Arc::new(move |category| {
        diagnostics.report(runtime_startup_diagnostic(category));
    })
}
