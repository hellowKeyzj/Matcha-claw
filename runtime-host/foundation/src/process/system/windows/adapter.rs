use super::super::super::{
    ExitObservation, LaunchRequest, ProcessObservation, TerminationFailure,
    resource::{
        BeginDrained, NativeAdapter, NativeCleanupResult, NativeDetachResult, NativeFuture,
        NativeInstallResult, NativePollResult, NativeStdio,
    },
    supervision::LaunchFailure,
};
#[path = "operation.rs"]
mod operation;

use super::custody::{CustodyCleanup, LaunchOutcome, WindowsCustody, install as install_custody};
use operation::BlockingOperation;

type InstallTask = BlockingOperation<LaunchOutcome>;
type CleanupTask = BlockingOperation<(WindowsCustody, Result<CustodyCleanup, TerminationFailure>)>;

pub(super) struct Adapter {
    custody: Option<WindowsCustody>,
    observation: Option<ProcessObservation>,
    install: Option<InstallTask>,
    cleanup: Option<CleanupTask>,
    terminal: Option<Terminal>,
}

#[derive(Clone)]
enum Terminal {
    Drained(ExitObservation),
    Terminated(ExitObservation),
}

impl Adapter {
    pub(super) fn new() -> Self {
        Self {
            custody: None,
            observation: None,
            install: None,
            cleanup: None,
            terminal: None,
        }
    }

    async fn install(&mut self, request: LaunchRequest) -> NativeInstallResult {
        let LaunchRequest {
            spec,
            child_descriptor,
            execution_source,
        } = request;
        if self.cleanup.is_some() || self.custody.is_some() {
            return NativeInstallResult::Unresolved {
                observation: self.observation,
                failure: TerminationFailure::CleanupUnconfirmed,
            };
        }
        self.observation = None;
        self.terminal = None;
        if self.install.is_none() {
            self.install = match BlockingOperation::spawn(
                "foundation-windows-install",
                (spec, child_descriptor, execution_source),
                install_custody,
            ) {
                Ok(operation) => Some(operation),
                Err(_) => {
                    return NativeInstallResult::Drained(BeginDrained::LaunchFailed(
                        LaunchFailure::ResourceUnavailable,
                    ));
                }
            };
        }

        let joined = self
            .install
            .as_mut()
            .expect("install task must exist before it is awaited")
            .join()
            .await;
        self.install = None;
        match joined {
            Ok(LaunchOutcome::Installed(custody, stdio)) => {
                let observation = custody.observation();
                self.observation = Some(observation);
                self.custody = Some(WindowsCustody::Owned(custody));
                NativeInstallResult::Installed(observation, NativeStdio::new(stdio))
            }
            Ok(LaunchOutcome::Drained(failure)) => {
                NativeInstallResult::Drained(BeginDrained::LaunchFailed(failure))
            }
            Ok(LaunchOutcome::Unresolved {
                custody,
                observation,
            }) => {
                self.observation = observation;
                self.custody = Some(WindowsCustody::Partial(custody));
                NativeInstallResult::Unresolved {
                    observation,
                    failure: TerminationFailure::CleanupUnconfirmed,
                }
            }
            Err(_) => NativeInstallResult::Unresolved {
                observation: None,
                failure: TerminationFailure::AuthorityLost,
            },
        }
    }

    async fn poll(&mut self) -> NativePollResult {
        if let Some(terminal) = &self.terminal {
            return terminal.poll();
        }
        let Some(custody) = self.custody.as_mut() else {
            return NativePollResult::Unresolved(TerminationFailure::AuthorityLost);
        };
        match custody.probe_exit() {
            Ok(Some(exit)) => {
                self.custody = None;
                self.observation = None;
                self.terminal = Some(Terminal::Drained(exit.clone()));
                NativePollResult::Drained(exit)
            }
            Ok(None) => NativePollResult::Pending,
            Err(_) => NativePollResult::Unresolved(TerminationFailure::AuthorityLost),
        }
    }

    async fn cleanup(&mut self) -> NativeCleanupResult {
        if let Some(terminal) = &self.terminal {
            return terminal.cleanup();
        }
        if self.cleanup.is_none() {
            let Some(custody) = self.custody.take() else {
                return NativeCleanupResult::Unresolved(TerminationFailure::AuthorityLost);
            };
            self.cleanup = match BlockingOperation::spawn(
                "foundation-windows-cleanup",
                custody,
                |mut custody| {
                    let result = custody.cleanup();
                    (custody, result)
                },
            ) {
                Ok(operation) => Some(operation),
                Err(custody) => {
                    self.custody = Some(custody);
                    return NativeCleanupResult::Unresolved(TerminationFailure::CleanupUnconfirmed);
                }
            };
        }

        let joined = self
            .cleanup
            .as_mut()
            .expect("cleanup task must exist before it is awaited")
            .join()
            .await;
        self.cleanup = None;
        match joined {
            Ok((_, Ok(CustodyCleanup::AlreadyDrained(exit)))) => {
                self.observation = None;
                self.terminal = Some(Terminal::Drained(exit.clone()));
                NativeCleanupResult::AlreadyDrained(exit)
            }
            Ok((_, Ok(CustodyCleanup::Terminated(exit)))) => {
                self.observation = None;
                self.terminal = Some(Terminal::Terminated(exit.clone()));
                NativeCleanupResult::Terminated(exit)
            }
            Ok((custody, Err(failure))) => {
                self.custody = Some(custody);
                NativeCleanupResult::Unresolved(failure)
            }
            Err(_) => NativeCleanupResult::Unresolved(TerminationFailure::AuthorityLost),
        }
    }

    async fn detach(&mut self) -> NativeDetachResult {
        if self.custody.is_none() && self.install.is_none() && self.cleanup.is_none() {
            NativeDetachResult::Detached
        } else {
            NativeDetachResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
        }
    }
}

impl Terminal {
    fn poll(&self) -> NativePollResult {
        match self {
            Self::Drained(exit) | Self::Terminated(exit) => NativePollResult::Drained(exit.clone()),
        }
    }

    fn cleanup(&self) -> NativeCleanupResult {
        match self {
            Self::Drained(exit) => NativeCleanupResult::AlreadyDrained(exit.clone()),
            Self::Terminated(exit) => NativeCleanupResult::Terminated(exit.clone()),
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

#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;
