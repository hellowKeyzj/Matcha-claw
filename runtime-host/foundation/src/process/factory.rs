#[cfg(unix)]
use std::path::PathBuf;

use super::{
    LaunchAttemptMaterializer,
    resource::ResourceRuntime,
    supervision::{
        GracefulStop, ReadinessProbe, RestartPolicy, StartRecovery, StdioActivation, Supervisor,
    },
};

/// Native containment mechanism for one supervised process scope.
#[derive(Clone)]
pub struct ProcessContainment {
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

impl ProcessContainment {
    /// Uses a private Windows Job Object to contain the scope.
    #[cfg(windows)]
    pub const fn job() -> Self {
        Self {}
    }

    /// Uses the absolute POSIX guardian executable to contain the scope.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidGuardianExecutable`](super::InvalidGuardianExecutable) when the
    /// executable path is not absolute.
    #[cfg(unix)]
    pub fn guardian(
        guardian_executable: PathBuf,
    ) -> Result<Self, super::InvalidGuardianExecutable> {
        if !guardian_executable.is_absolute() {
            return Err(super::InvalidGuardianExecutable);
        }
        Ok(Self {
            guardian_executable,
        })
    }

    #[cfg(unix)]
    fn into_guardian_executable(self) -> PathBuf {
        self.guardian_executable
    }

    fn resource<M: LaunchAttemptMaterializer>(self, materializer: M) -> ResourceRuntime {
        #[cfg(windows)]
        {
            let _ = self;
            super::system::windows::resource(materializer)
        }
        #[cfg(unix)]
        {
            super::system::posix::resource(self.into_guardian_executable(), materializer)
                .expect("guardian containment validates its executable")
        }
    }
}

/// Creates the sole lifecycle owner for a process scope using its containment mechanism.
pub fn supervise<M, A, R, G, S, T>(
    containment: ProcessContainment,
    materializer: M,
    stdio_activation: A,
    readiness: R,
    graceful_stop: G,
    recovery: S,
    restart_policy: T,
) -> Supervisor
where
    M: LaunchAttemptMaterializer,
    A: StdioActivation,
    R: ReadinessProbe,
    G: GracefulStop,
    S: StartRecovery,
    T: RestartPolicy,
{
    Supervisor::new(
        containment.resource(materializer),
        stdio_activation,
        readiness,
        graceful_stop,
        recovery,
        restart_policy,
    )
}

#[cfg(test)]
mod tests {
    use super::ProcessContainment;

    #[cfg(unix)]
    #[test]
    fn guardian_containment_rejects_a_relative_executable() {
        let error = match ProcessContainment::guardian("relative-guardian".into()) {
            Err(error) => error,
            Ok(_) => panic!("relative guardian executable must be rejected"),
        };

        assert_eq!(error, super::super::InvalidGuardianExecutable);
    }

    #[cfg(windows)]
    #[test]
    fn job_containment_constructs() {
        let _ = ProcessContainment::job();
    }
}
