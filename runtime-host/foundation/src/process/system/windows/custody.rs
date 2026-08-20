use super::{
    super::super::{
        AuthorityScope, ChildDescriptor, ExitObservation, LaunchSpec, ProcessIdentity,
        ProcessObservation, ProcessStdio, Provenance, ScopeId, TerminationFailure,
        supervision::LaunchFailure,
    },
    child::SuspendedChild,
    command::CreateProcessInput,
    error::WindowsCustodyError,
    handle::Handle,
    job::{self, Job, ScopeExitProbe, ScopeTermination},
    stdio::{ChildStdio, ParentStdio},
};

type Result<T> = std::result::Result<T, WindowsCustodyError>;

pub(super) enum LaunchOutcome {
    Installed(WindowsAuthorityScope, ProcessStdio),
    Drained(LaunchFailure),
    Unresolved {
        custody: PartialCustody,
        observation: Option<ProcessObservation>,
    },
}

pub(super) enum WindowsCustody {
    Owned(WindowsAuthorityScope),
    Partial(PartialCustody),
}

pub(super) enum CustodyCleanup {
    AlreadyDrained(ExitObservation),
    Terminated(ExitObservation),
}

#[cfg(test)]
impl CustodyCleanup {
    fn exit(&self) -> ExitObservation {
        match self {
            Self::AlreadyDrained(exit) | Self::Terminated(exit) => exit.clone(),
        }
    }
}

pub(crate) struct WindowsAuthorityScope {
    observation: ProcessObservation,
    process: Handle,
    job: Job,
}

pub(super) struct PartialCustody {
    process: Handle,
    job: Job,
}

impl WindowsAuthorityScope {
    #[cfg(test)]
    pub(crate) const fn root_identity(&self) -> ProcessIdentity {
        self.observation.identity()
    }

    pub(crate) const fn observation(&self) -> ProcessObservation {
        self.observation
    }

    pub(crate) fn probe_exit(&mut self) -> Result<Option<ExitObservation>> {
        probe_exit(&self.job, &self.process)
    }

    #[cfg(test)]
    pub(crate) fn terminate(&mut self) -> Result<ExitObservation> {
        self.terminate_cleanup().map(|cleanup| cleanup.exit())
    }

    fn terminate_cleanup(&mut self) -> Result<CustodyCleanup> {
        terminate(&self.job, &self.process, self.observation.identity())
    }
}

impl WindowsCustody {
    pub(super) fn probe_exit(&mut self) -> Result<Option<ExitObservation>> {
        match self {
            Self::Owned(custody) => custody.probe_exit(),
            Self::Partial(custody) => probe_exit(&custody.job, &custody.process),
        }
    }

    pub(super) fn cleanup(&mut self) -> std::result::Result<CustodyCleanup, TerminationFailure> {
        match self.probe_exit() {
            Ok(Some(exit)) => return Ok(CustodyCleanup::AlreadyDrained(exit)),
            Ok(None) => {}
            Err(_) => return Err(TerminationFailure::AuthorityLost),
        }
        let result = match self {
            Self::Owned(custody) => custody.terminate_cleanup(),
            Self::Partial(custody) => terminate_after_failed_spawn(&custody.job, &custody.process),
        };
        result.map_err(|_| TerminationFailure::CleanupUnconfirmed)
    }
}

pub(super) fn install(
    (spec, child_descriptor, execution_source): (
        LaunchSpec,
        Option<ChildDescriptor>,
        Option<super::super::super::ExecutionSource>,
    ),
) -> LaunchOutcome {
    let job = match job::create() {
        Ok(job) => job,
        Err(error) => return LaunchOutcome::Drained(error.launch_failure()),
    };
    let mut input = match CreateProcessInput::from_spec(&spec) {
        Ok(input) => input,
        Err(error) => return LaunchOutcome::Drained(error.launch_failure()),
    };
    let stdio = match ChildStdio::create(spec.stdio()) {
        Ok(stdio) => stdio,
        Err(error) => return LaunchOutcome::Drained(error.launch_failure()),
    };
    let child = match SuspendedChild::spawn(
        &mut input,
        &job,
        &stdio,
        child_descriptor.as_ref(),
        execution_source,
    ) {
        Ok(child) => child,
        Err(error) => return LaunchOutcome::Drained(error.launch_failure()),
    };
    finish_launch(child, job, stdio.into_parent())
}

#[cfg(test)]
pub(crate) fn launch(spec: &LaunchSpec) -> Result<WindowsAuthorityScope> {
    match install((spec.clone(), None, None)) {
        LaunchOutcome::Installed(custody, _) => Ok(custody),
        LaunchOutcome::Drained(_) => Err(WindowsCustodyError::invalid("process launch failed")),
        LaunchOutcome::Unresolved { .. } => Err(WindowsCustodyError::invalid(
            "process launch cleanup was not confirmed",
        )),
    }
}

fn finish_launch(child: SuspendedChild, job: Job, stdio: ParentStdio) -> LaunchOutcome {
    let root = match child.identity() {
        Ok(root) => root,
        Err(error) => {
            return failed_after_spawn(error, child, job, None);
        }
    };
    let scope = AuthorityScope::owned(scope_id(root, child.process(), &job));
    let observation = observation(root, scope);
    let stdio = match stdio.into_stdio() {
        Ok(stdio) => stdio,
        Err(error) => {
            return failed_after_spawn(error, child, job, Some(observation));
        }
    };
    if let Err(error) = child.resume() {
        return failed_after_spawn(error, child, job, Some(observation));
    }
    LaunchOutcome::Installed(
        WindowsAuthorityScope {
            observation,
            process: child.into_process(),
            job,
        },
        stdio,
    )
}

fn failed_after_spawn(
    error: WindowsCustodyError,
    child: SuspendedChild,
    job: Job,
    observation: Option<ProcessObservation>,
) -> LaunchOutcome {
    if job::terminate_after_failed_spawn(&job, child.process()).is_ok() {
        LaunchOutcome::Drained(error.launch_failure())
    } else {
        LaunchOutcome::Unresolved {
            custody: PartialCustody {
                process: child.into_process(),
                job,
            },
            observation,
        }
    }
}

fn probe_exit(job: &Job, process: &Handle) -> Result<Option<ExitObservation>> {
    match job::probe_scope_exit(job, process)? {
        ScopeExitProbe::Pending => Ok(None),
        ScopeExitProbe::Confirmed => process.exit_observation().map(Some),
    }
}

fn terminate(job: &Job, process: &Handle, identity: ProcessIdentity) -> Result<CustodyCleanup> {
    match job::terminate(job, process, identity)? {
        ScopeTermination::AlreadyDrained => process
            .exit_observation()
            .map(CustodyCleanup::AlreadyDrained),
        ScopeTermination::Terminated => process.exit_observation().map(CustodyCleanup::Terminated),
    }
}

fn terminate_after_failed_spawn(job: &Job, process: &Handle) -> Result<CustodyCleanup> {
    job::terminate_after_failed_spawn(job, process)?;
    process.exit_observation().map(CustodyCleanup::Terminated)
}

const fn observation(root: ProcessIdentity, scope: AuthorityScope) -> ProcessObservation {
    ProcessObservation::new(root, Provenance::Spawned { scope })
}

fn scope_id(root: ProcessIdentity, process: &Handle, job: &Job) -> ScopeId {
    let mut value = root.creation_marker() as u64 ^ u64::from(root.pid()).rotate_left(29);
    for handle in [process.raw(), job.raw()] {
        value =
            (value ^ (handle as usize as u64).rotate_left(17)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
    let mut bytes = [0; 16];
    bytes[..8].copy_from_slice(&value.to_le_bytes());
    bytes[8..].copy_from_slice(&value.rotate_left(31).to_be_bytes());
    ScopeId::new(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_marks_the_root_as_spawned_in_its_owned_scope() {
        let root = ProcessIdentity::new(42, 9);
        let scope = AuthorityScope::owned(ScopeId::new([7; 16]));
        let observed = observation(root, scope);

        assert_eq!(observed.identity(), root);
        assert_eq!(observed.provenance(), Provenance::Spawned { scope });
    }
}
