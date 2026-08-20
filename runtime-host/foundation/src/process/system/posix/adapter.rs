use std::io;
use std::path::PathBuf;

use super::super::super::{
    ExitObservation, LaunchRequest, ProcessObservation, Provenance, TerminationFailure,
    resource::{
        BeginDrained, NativeAdapter, NativeCleanupResult, NativeDetachResult, NativeFuture,
        NativeInstallResult, NativePollResult, NativeStdio,
    },
    supervision::LaunchFailure,
    task::TaskOwner,
};
use super::InvalidGuardianExecutable;
use super::custody::{CustodyDrain, CustodyFailure, NativeCustody, SpawnFailure};

type DrainTask = TaskOwner<(NativeCustody, Result<CustodyDrain, CustodyFailure>)>;

pub(super) struct Adapter {
    guardian_executable: PathBuf,
    custody: Option<NativeCustody>,
    observation: Option<ProcessObservation>,
    drain: Option<DrainTask>,
    terminal: Option<Terminal>,
}

#[derive(Clone)]
enum Terminal {
    Drained(ExitObservation),
    Terminated(ExitObservation),
    Unresolved(TerminationFailure),
}

impl Adapter {
    pub(super) fn new(guardian_executable: PathBuf) -> Result<Self, InvalidGuardianExecutable> {
        if !guardian_executable.is_absolute() {
            return Err(InvalidGuardianExecutable);
        }
        Ok(Self {
            guardian_executable,
            custody: None,
            observation: None,
            drain: None,
            terminal: None,
        })
    }

    async fn install(&mut self, request: LaunchRequest) -> NativeInstallResult {
        let LaunchRequest {
            spec,
            child_descriptor,
            execution_source,
            custody,
        } = request;
        if self.drain.is_some() {
            let result = self.await_drain().await;
            let _ = self.record_drain(result);
        }
        if matches!(self.terminal, Some(Terminal::Drained(_))) {
            self.terminal = None;
        }
        if self.custody.is_some() || self.terminal.is_some() {
            return NativeInstallResult::Unresolved {
                observation: self.observation,
                failure: match self.terminal.as_ref() {
                    Some(Terminal::Unresolved(failure)) => *failure,
                    _ if self.custody.is_some() => TerminationFailure::CleanupUnconfirmed,
                    _ => TerminationFailure::AuthorityLost,
                },
            };
        }
        self.observation = None;

        let private_descriptor = child_descriptor.map(crate::process::ChildDescriptor::into_owned);
        let execution_source = match execution_source {
            Some(source) => match linux_execution_source(source) {
                Ok(source) => Some(source),
                Err(()) => {
                    return NativeInstallResult::Drained(BeginDrained::LaunchFailed(
                        LaunchFailure::PlatformRejected,
                    ));
                }
            },
            None => None,
        };
        let (mut custody, host_stdio) = match NativeCustody::spawn(
            &self.guardian_executable,
            &spec,
            custody,
            private_descriptor,
            execution_source,
        )
        .await
        {
            Ok(custody) => custody,
            Err(SpawnFailure::Launch(error)) => {
                return NativeInstallResult::Drained(BeginDrained::LaunchFailed(launch_failure(
                    error.kind(),
                )));
            }
            Err(SpawnFailure::AuthorityLost) => {
                let failure = TerminationFailure::CleanupUnconfirmed;
                self.terminal = Some(Terminal::Unresolved(failure));
                return NativeInstallResult::Unresolved {
                    observation: None,
                    failure,
                };
            }
        };
        match custody.launch(&spec, host_stdio).await {
            Ok(launched) => {
                let observation = ProcessObservation::new(
                    launched.root_identity(),
                    Provenance::Spawned {
                        scope: launched.authority_scope(),
                    },
                );
                self.custody = Some(custody);
                self.observation = Some(observation);
                NativeInstallResult::Installed(observation, NativeStdio::new(launched.into_stdio()))
            }
            Err(CustodyFailure::LaunchFailed) => NativeInstallResult::Drained(
                BeginDrained::LaunchFailed(LaunchFailure::PlatformRejected),
            ),
            Err(CustodyFailure::CleanupUnconfirmed) => {
                self.custody = Some(custody);
                NativeInstallResult::Unresolved {
                    observation: None,
                    failure: TerminationFailure::CleanupUnconfirmed,
                }
            }
            Err(failure) => {
                let failure = termination_failure(failure);
                self.terminal = Some(Terminal::Unresolved(failure));
                NativeInstallResult::Unresolved {
                    observation: None,
                    failure,
                }
            }
        }
    }

    async fn poll(&mut self) -> NativePollResult {
        if self.drain.is_none()
            && let Some(result) = self.terminal_poll()
        {
            return result;
        }
        if self.drain.is_none() {
            let Some(mut custody) = self.custody.take() else {
                return self.record_unresolved(TerminationFailure::AuthorityLost);
            };
            self.drain = Some(TaskOwner::spawn(async move {
                let result = custody.poll_drained().await;
                (custody, result)
            }));
        }
        let result = self.await_drain().await;
        self.record_drain(result)
    }

    async fn cleanup(&mut self) -> NativeCleanupResult {
        if self.drain.is_some() {
            match self.await_drain().await {
                Ok(CustodyDrain::Drained(exit)) => {
                    self.custody = None;
                    self.terminal = Some(Terminal::Drained(exit.clone()));
                    return NativeCleanupResult::AlreadyDrained(exit);
                }
                Ok(CustodyDrain::Pending) => {}
                Err(_) => return self.cleanup_unresolved(),
            }
        }
        if let Some(result) = self.terminal_cleanup() {
            return result;
        }

        let Some(mut custody) = self.custody.take() else {
            return self.cleanup_unresolved();
        };
        let result = custody.terminate().await;
        if custody.guardian.is_some() {
            self.custody = Some(custody);
        }
        match result {
            Ok(exit) => {
                self.terminal = Some(Terminal::Terminated(exit.clone()));
                NativeCleanupResult::Terminated(exit)
            }
            Err(_) => self.cleanup_unresolved(),
        }
    }

    async fn detach(&mut self) -> NativeDetachResult {
        if self.drain.is_some() {
            let result = self.await_drain().await;
            let _ = self.record_drain(result);
        }
        if self.custody.is_some() {
            NativeDetachResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
        } else if let Some(Terminal::Unresolved(failure)) = self.terminal.as_ref() {
            NativeDetachResult::Unresolved(*failure)
        } else {
            NativeDetachResult::Detached
        }
    }

    async fn await_drain(&mut self) -> Result<CustodyDrain, CustodyFailure> {
        let joined = self
            .drain
            .as_mut()
            .expect("drain task must exist before it is awaited")
            .await;
        self.drain = None;
        match joined {
            Ok((custody, result)) => {
                self.custody = Some(custody);
                result
            }
            Err(_) => Err(CustodyFailure::AuthorityLost),
        }
    }

    fn record_drain(&mut self, result: Result<CustodyDrain, CustodyFailure>) -> NativePollResult {
        match result {
            Ok(CustodyDrain::Pending) => NativePollResult::Pending,
            Ok(CustodyDrain::Drained(exit)) => {
                self.custody = None;
                self.terminal = Some(Terminal::Drained(exit.clone()));
                NativePollResult::Drained(exit)
            }
            Err(failure) => {
                if self
                    .custody
                    .as_ref()
                    .is_some_and(|custody| custody.guardian.is_none())
                {
                    self.custody = None;
                }
                if self.custody.is_some() {
                    NativePollResult::Unresolved(termination_failure(failure))
                } else {
                    self.record_unresolved(TerminationFailure::AuthorityLost)
                }
            }
        }
    }

    fn record_unresolved(&mut self, failure: TerminationFailure) -> NativePollResult {
        self.terminal = Some(Terminal::Unresolved(failure));
        NativePollResult::Unresolved(failure)
    }

    fn cleanup_unresolved(&mut self) -> NativeCleanupResult {
        if self
            .custody
            .as_ref()
            .is_some_and(|custody| custody.guardian.is_some())
        {
            return NativeCleanupResult::Unresolved(TerminationFailure::CleanupUnconfirmed);
        }
        self.custody = None;
        self.terminal = Some(Terminal::Unresolved(TerminationFailure::AuthorityLost));
        NativeCleanupResult::Unresolved(TerminationFailure::AuthorityLost)
    }

    fn terminal_poll(&self) -> Option<NativePollResult> {
        match self.terminal.as_ref()? {
            Terminal::Drained(exit) | Terminal::Terminated(exit) => {
                Some(NativePollResult::Drained(exit.clone()))
            }
            Terminal::Unresolved(failure) => Some(NativePollResult::Unresolved(*failure)),
        }
    }

    fn terminal_cleanup(&self) -> Option<NativeCleanupResult> {
        match self.terminal.as_ref()? {
            Terminal::Drained(exit) => Some(NativeCleanupResult::AlreadyDrained(exit.clone())),
            Terminal::Terminated(exit) => Some(NativeCleanupResult::Terminated(exit.clone())),
            Terminal::Unresolved(failure) => Some(NativeCleanupResult::Unresolved(*failure)),
        }
    }
}

impl NativeAdapter for Adapter {
    fn install(&mut self, request: LaunchRequest) -> NativeFuture<'_, NativeInstallResult> {
        Box::pin(Adapter::install(self, request))
    }

    fn poll(&mut self) -> NativeFuture<'_, NativePollResult> {
        Box::pin(Adapter::poll(self))
    }

    fn cleanup(&mut self) -> NativeFuture<'_, NativeCleanupResult> {
        Box::pin(Adapter::cleanup(self))
    }

    fn detach(&mut self) -> NativeFuture<'_, NativeDetachResult> {
        Box::pin(Adapter::detach(self))
    }
}

#[cfg(target_os = "linux")]
fn linux_execution_source(
    source: crate::process::ExecutionSource,
) -> Result<std::os::fd::OwnedFd, ()> {
    Ok(source.into_linux_fd())
}

#[cfg(not(target_os = "linux"))]
fn linux_execution_source(_: crate::process::ExecutionSource) -> Result<std::os::fd::OwnedFd, ()> {
    // No safe descriptor-native exec primitive is available on supported non-Linux POSIX.
    Err(())
}

fn launch_failure(kind: io::ErrorKind) -> LaunchFailure {
    match kind {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => {
            LaunchFailure::ArtifactUnavailable
        }
        io::ErrorKind::PermissionDenied => LaunchFailure::PermissionDenied,
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::OutOfMemory => {
            LaunchFailure::ResourceUnavailable
        }
        _ => LaunchFailure::PlatformRejected,
    }
}

const fn termination_failure(failure: CustodyFailure) -> TerminationFailure {
    match failure {
        CustodyFailure::AuthorityLost => TerminationFailure::AuthorityLost,
        CustodyFailure::CleanupUnconfirmed | CustodyFailure::LaunchFailed => {
            TerminationFailure::CleanupUnconfirmed
        }
    }
}

#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;
