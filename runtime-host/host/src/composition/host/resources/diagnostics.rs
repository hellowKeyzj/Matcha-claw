use std::path::PathBuf;

use openclaw::lifecycle::state_dir::CanonicalStateDir;

use crate::composition::host::ConstructionError;
use ::diagnostics::{
    DiagnosticsArchiveProducer, DiagnosticsArchiveRoot, RuntimeFlightRecorder,
    RuntimeStartupDiagnostics,
};

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

pub(in crate::composition::host) fn provision_diagnostics_archive(
    diagnostics_state_root: &CanonicalStateDir,
    app_log_dir: PathBuf,
    runtime_observation: RuntimeFlightRecorder,
) -> Result<DiagnosticsArchiveProducer, ConstructionError> {
    let diagnostics_root =
        DiagnosticsArchiveRoot::provision(diagnostics_state_root.as_path(), app_log_dir)
            .map_err(ConstructionError::Diagnostics)?;
    DiagnosticsArchiveProducer::new_with_recorder(diagnostics_root, runtime_observation)
        .map_err(ConstructionError::Diagnostics)
}
