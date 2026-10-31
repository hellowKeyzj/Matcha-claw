use std::path::PathBuf;

use platform::state_dir::CanonicalStateDir;

use ::diagnostics::{DiagnosticsArchiveProducer, RuntimeFlightRecorder, RuntimeStartupDiagnostics};

pub(in crate::composition::host) struct RuntimeDiagnostics {
    pub(in crate::composition::host) observation: RuntimeFlightRecorder,
    pub(in crate::composition::host) matcha_startup: RuntimeStartupDiagnostics,
    pub(in crate::composition::host) openclaw_startup: RuntimeStartupDiagnostics,
}

pub(in crate::composition::host) fn prepare_runtime_diagnostics(
    runtime_observation: ::diagnostics::RuntimeObservationConfig,
) -> RuntimeDiagnostics {
    RuntimeDiagnostics {
        observation: RuntimeFlightRecorder::new(runtime_observation),
        matcha_startup: RuntimeStartupDiagnostics::new(),
        openclaw_startup: RuntimeStartupDiagnostics::new(),
    }
}

pub(in crate::composition::host) fn prepare_diagnostics_archive(
    diagnostics_state_root: &CanonicalStateDir,
    app_log_dir: PathBuf,
    runtime_observation: RuntimeFlightRecorder,
) -> DiagnosticsArchiveProducer {
    DiagnosticsArchiveProducer::from_paths(
        diagnostics_state_root.as_path().to_path_buf(),
        app_log_dir,
        runtime_observation,
    )
}
