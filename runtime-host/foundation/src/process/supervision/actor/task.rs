use tokio::task::{Id, JoinError};

use super::super::super::TerminationFailure;
use super::super::{
    ControlIntent, GracefulStop, LaunchFailure, ReadinessProbe, RestartPolicy, StartRecovery,
    StdioActivation, SupervisorFailure,
    worker::{TaskIdentity, Work},
};
use super::runtime::Actor;

impl<A, R, G, S, T> Actor<A, R, G, S, T>
where
    A: StdioActivation,
    R: ReadinessProbe,
    G: GracefulStop,
    S: StartRecovery,
    T: RestartPolicy,
{
    pub(super) fn record_work(&mut self, work: &Work) {
        let identity = match work {
            Work::BeginEnqueued(request_id) | Work::BeginOwnerClosed(request_id) => {
                TaskIdentity::Begin(*request_id)
            }
            Work::StdioActivation {
                generation, epoch, ..
            } => TaskIdentity::StdioActivation {
                generation: *generation,
                epoch: *epoch,
            },
            Work::NativeActivation {
                request_id, epoch, ..
            } => TaskIdentity::NativeActivation {
                request_id: *request_id,
                epoch: *epoch,
            },
            Work::StdioDrain { epoch, .. } => TaskIdentity::StdioDrain { epoch: *epoch },
            Work::Readiness {
                generation, epoch, ..
            } => TaskIdentity::Readiness {
                generation: *generation,
                epoch: *epoch,
            },
            Work::Recovery { generation, .. } => TaskIdentity::Recovery(*generation),
            Work::Graceful {
                generation, epoch, ..
            } => TaskIdentity::Graceful {
                generation: *generation,
                epoch: *epoch,
            },
            Work::WaitDrained {
                generation, epoch, ..
            } => TaskIdentity::WaitDrained {
                generation: *generation,
                epoch: *epoch,
            },
            Work::Kill { epoch, .. } => TaskIdentity::Kill(*epoch),
            Work::Shutdown(_) => TaskIdentity::Shutdown,
            Work::ShutdownRetry(_) => TaskIdentity::ShutdownRetry,
            Work::Timer(generation) => TaskIdentity::Timer(*generation),
        };
        if let Some((_, _, delivered)) = self
            .task_identities
            .iter_mut()
            .find(|(_, task_identity, delivered)| *task_identity == identity && !*delivered)
        {
            *delivered = true;
        }
    }

    pub(super) fn task_finished(&mut self, result: Result<(Id, TaskIdentity), JoinError>) {
        let (id, identity) = match result {
            Ok((id, identity)) => (id, identity),
            Err(error) => {
                let id = error.id();
                let Some(identity) = self.identity(id) else {
                    return;
                };
                (id, identity)
            }
        };
        let Some(index) = self
            .task_identities
            .iter()
            .position(|(task_id, _, _)| *task_id == id)
        else {
            return;
        };
        let (_, _, delivered) = self.task_identities.swap_remove(index);
        if !delivered {
            self.task_failed(identity);
        }
    }

    fn identity(&self, id: Id) -> Option<TaskIdentity> {
        self.task_identities
            .iter()
            .find_map(|(task_id, identity, _)| (*task_id == id).then_some(*identity))
    }

    fn task_failed(&mut self, identity: TaskIdentity) {
        match identity {
            TaskIdentity::Begin(request_id) => {
                if self.state.begin_in_flight == Some(request_id) {
                    self.state.begin_in_flight = None;
                    self.resource_closed();
                }
            }
            TaskIdentity::StdioActivation { generation, epoch } => {
                if self.state.pending_stdio_activation == Some((generation, epoch)) {
                    self.stdio_activation_failed(epoch);
                }
            }
            TaskIdentity::NativeActivation { request_id, epoch } => {
                if self.state.pending_native_activation == Some((request_id, epoch)) {
                    self.state.pending_native_activation = None;
                    self.native_activation_failed(epoch);
                }
            }
            TaskIdentity::StdioDrain { epoch } => {
                if self.state.stdio_drain_epoch == Some(epoch) {
                    self.stdio_drain_completed(
                        epoch,
                        super::super::worker::StdioDrainCompletion::Completed(
                            super::super::super::StdioDrainResult::Unavailable,
                        ),
                    );
                }
            }
            TaskIdentity::Readiness { generation, epoch } => {
                if generation == self.state.generation && self.state.active_epoch == Some(epoch) {
                    self.start_readiness_recovery(epoch);
                }
            }
            TaskIdentity::Recovery(generation) | TaskIdentity::Timer(generation) => {
                if generation == self.state.generation {
                    let failure =
                        self.state
                            .failure
                            .clone()
                            .unwrap_or(SupervisorFailure::LaunchFailed(
                                LaunchFailure::PlatformRejected,
                            ));
                    self.fail(failure);
                }
            }
            TaskIdentity::Graceful { generation, epoch }
            | TaskIdentity::WaitDrained { generation, epoch } => {
                if generation == self.state.generation && self.state.active_epoch == Some(epoch) {
                    self.issue_kill(epoch);
                }
            }
            TaskIdentity::Kill(epoch) => {
                if self.state.active_epoch == Some(epoch) {
                    self.resource_request_failed(
                        super::super::super::resource::ResourceFailure::OwnerStopped,
                    );
                }
            }
            TaskIdentity::Shutdown => {
                if self.state.intent == Some(ControlIntent::Shutdown) {
                    self.complete_unresolved_shutdown(TerminationFailure::CleanupUnconfirmed);
                }
            }
            TaskIdentity::ShutdownRetry => {
                if self.shutdown_retry_pending {
                    self.shutdown_retry_pending = false;
                    self.complete_unresolved_shutdown(TerminationFailure::CleanupUnconfirmed);
                }
            }
            #[cfg(test)]
            TaskIdentity::Probe => {}
        }
    }
}
