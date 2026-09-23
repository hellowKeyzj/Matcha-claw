use std::fmt;

use foundation::process::{
    LaunchAttempt, LaunchAttemptCleanupFailure, LaunchAttemptGuard, LaunchMaterializationFailure,
    LaunchSpec, supervision::LaunchFailure,
};

use super::CanonicalStateDir;
use platform::state_dir::StateDirHandle;

#[cfg(unix)]
mod canonical;

pub(super) struct PreparedAttempt {
    spec: LaunchSpec,
    state_dir: CanonicalStateDir,
}

impl PreparedAttempt {
    pub(super) fn new(spec: LaunchSpec, state_dir: CanonicalStateDir) -> Self {
        Self { spec, state_dir }
    }

    #[cfg(test)]
    pub(super) fn spec(&self) -> &LaunchSpec {
        &self.spec
    }

    pub(super) fn materialize(self) -> Result<LaunchAttempt, LaunchMaterializationFailure> {
        let state_dir = self
            .state_dir
            .open()
            .map_err(|_| LaunchMaterializationFailure::new(LaunchFailure::ResourceUnavailable))?;
        let files = AttemptFiles {
            state_dir: Some(state_dir),
        };
        #[cfg(unix)]
        if canonical::ensure(
            files
                .state_dir
                .as_ref()
                .expect("materialized attempt must retain its state-directory lease"),
        )
        .is_err()
        {
            return Err(files.materialization_failure());
        }
        Ok(LaunchAttempt::new(self.spec, files))
    }
}

#[derive(Default)]
struct AttemptFiles {
    state_dir: Option<StateDirHandle>,
}

impl AttemptFiles {
    #[cfg(unix)]
    fn materialization_failure(self) -> LaunchMaterializationFailure {
        if self.state_dir.is_some() {
            LaunchMaterializationFailure::with_guard(LaunchFailure::ResourceUnavailable, self)
        } else {
            LaunchMaterializationFailure::new(LaunchFailure::ResourceUnavailable)
        }
    }

    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        self.state_dir = None;
        Ok(())
    }
}

impl LaunchAttemptGuard for AttemptFiles {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        self.cleanup()
    }
}

impl fmt::Debug for AttemptFiles {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("AttemptFiles(<redacted>)")
    }
}

#[cfg(test)]
#[path = "attempt/tests.rs"]
mod tests;
