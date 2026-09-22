use std::sync::Arc;

use diagnostics_module::{RuntimeStartupDiagnostic, RuntimeStartupDiagnostics};

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

pub fn runtime_diagnostic_reporter(
    diagnostics: RuntimeStartupDiagnostics,
) -> Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync> {
    Arc::new(move |category| {
        diagnostics.report(runtime_startup_diagnostic(category));
    })
}
