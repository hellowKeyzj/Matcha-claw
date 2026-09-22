use std::sync::Arc;

use diagnostics_module::{RuntimeStartupDiagnostic, RuntimeStartupDiagnostics};

use crate::lifecycle::logs::{LifecycleDiagnostic, LifecycleDiagnosticCategory};

pub const fn runtime_startup_diagnostic(
    category: LifecycleDiagnosticCategory,
) -> RuntimeStartupDiagnostic {
    match category {
        LifecycleDiagnosticCategory::ListenerReported => RuntimeStartupDiagnostic::ListenerReported,
        LifecycleDiagnosticCategory::PortConflict => RuntimeStartupDiagnostic::PortConflict,
        LifecycleDiagnosticCategory::ConfigurationRejected => {
            RuntimeStartupDiagnostic::ConfigurationRejected
        }
        LifecycleDiagnosticCategory::BindRejected => RuntimeStartupDiagnostic::BindRejected,
        LifecycleDiagnosticCategory::StartupFailed => RuntimeStartupDiagnostic::StartupFailed,
        LifecycleDiagnosticCategory::InvalidEncoding => RuntimeStartupDiagnostic::InvalidEncoding,
        LifecycleDiagnosticCategory::LineTooLong => RuntimeStartupDiagnostic::LineTooLong,
        LifecycleDiagnosticCategory::DiagnosticLimitReached => {
            RuntimeStartupDiagnostic::DiagnosticLimitReached
        }
    }
}

pub const fn configuration_rejected() -> RuntimeStartupDiagnostic {
    RuntimeStartupDiagnostic::ConfigurationRejected
}

pub fn runtime_diagnostic_reporter(
    diagnostics: RuntimeStartupDiagnostics,
) -> Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync> {
    Arc::new(move |diagnostic| {
        diagnostics.report(runtime_startup_diagnostic(diagnostic.category()));
    })
}
