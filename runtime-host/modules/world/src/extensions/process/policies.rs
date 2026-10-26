use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use foundation::process::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    supervision::{
        GracefulStop, GracefulStopResult, PolicyFuture, ReadinessProbe, ReadinessResult,
        StdioActivation,
    },
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    lifecycle::LifecycleOperation,
    process::{SystemMethod, SystemValue},
};

use super::{
    close::{CloseFailure, CloseStage, JoinedTask},
    error::ProcessError,
    io::{self as protocol_io, IoResult},
    session::{Receivers, Session},
    stderr::{self, StderrCapture, StderrResult},
};

pub(super) struct ProtocolTasks {
    pub(super) reader: JoinedTask<IoResult>,
    pub(super) writer: JoinedTask<IoResult>,
    pub(super) stderr: JoinedTask<StderrResult>,
    _capture: Arc<Mutex<StderrCapture>>,
}

#[derive(Clone)]
pub(super) struct Policies {
    pub(super) session: Arc<Session>,
    pub(super) tasks: Arc<tokio::sync::Mutex<Option<ProtocolTasks>>>,
    receivers: Arc<Mutex<Option<Receivers>>>,
    deadline: Instant,
    stop_timeout: Duration,
}

impl Policies {
    pub(super) fn new(
        session: Arc<Session>,
        receivers: Receivers,
        deadline: Instant,
        stop_timeout: Duration,
    ) -> Self {
        Self {
            session,
            tasks: Arc::new(tokio::sync::Mutex::new(None)),
            receivers: Arc::new(Mutex::new(Some(receivers))),
            deadline,
            stop_timeout,
        }
    }
}

impl StdioActivation for Policies {
    fn activate(
        &self,
        _process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let policy = self.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() || policy.session.cleanup.host_only() {
                return StdioActivationResult::Cancelled;
            }
            let (stdin, stdout, stderr) = stdio.into_parts();
            let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
                return StdioActivationResult::Unavailable;
            };
            let Some(receivers) = policy
                .receivers
                .lock()
                .expect("process activation receivers poisoned")
                .take()
            else {
                return StdioActivationResult::Unavailable;
            };
            let mut tasks = policy.tasks.lock().await;
            let capture = StderrCapture::new();
            let stderr_session = policy.session.clone();
            let stderr_task = stderr::collect(stderr, capture.clone(), move |failure| {
                if let Some(cause) = failure {
                    stderr_session.fail(Arc::new(ProcessError::Stderr(cause)));
                }
                stderr_session
                    .status
                    .send_modify(|status| status.stderr_done = true);
            });
            *tasks = Some(ProtocolTasks {
                reader: JoinedTask::new(protocol_io::reader(
                    stdout,
                    policy.session.clone(),
                    policy.deadline,
                )),
                writer: JoinedTask::new(protocol_io::writer(
                    stdin,
                    receivers,
                    policy.session.clone(),
                )),
                stderr: JoinedTask::new(stderr_task),
                _capture: capture,
            });
            drop(tasks);
            let mut status = policy.session.status.subscribe();
            // Never await hello here: Windows has not resumed the suspended child yet.
            StdioActivationResult::Activated(StdioDrain::new(async move {
                loop {
                    let snapshot = status.borrow_and_update().clone();
                    if snapshot.reader_done && snapshot.writer_done && snapshot.stderr_done {
                        return if snapshot.failed {
                            StdioDrainResult::Unavailable
                        } else {
                            StdioDrainResult::Drained
                        };
                    }
                    if status.changed().await.is_err() {
                        return StdioDrainResult::Unavailable;
                    }
                }
            }))
        })
    }
}

impl ReadinessProbe for Policies {
    fn wait_ready(
        &self,
        _process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let policy = self.clone();
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => ReadinessResult::Cancelled,
                _ = policy.session.cleanup.quarantined() => ReadinessResult::Cancelled,
                result = policy.session.wait_ready(policy.deadline) => {
                    if result.is_ok() { ReadinessResult::Ready } else { ReadinessResult::Unavailable }
                }
            }
        })
    }
}

impl GracefulStop for Policies {
    fn grace_period(&self) -> Duration {
        self.stop_timeout
    }

    fn request_stop(
        &self,
        _process: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        let policy = self.clone();
        Box::pin(async move {
            if policy.session.cleanup.host_only() {
                return GracefulStopResult::Cancelled;
            }
            let deadline = Instant::now() + policy.stop_timeout;
            if policy.session.materials().is_some() {
                return tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => GracefulStopResult::Cancelled,
                    result = policy.session.drain(LifecycleOperation::Stop, deadline) => {
                        if result.is_ok() { GracefulStopResult::Requested } else { GracefulStopResult::Rejected }
                    }
                };
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => GracefulStopResult::Cancelled,
                _ = policy.session.cleanup.quarantined() => GracefulStopResult::Cancelled,
                result = policy.session.system(SystemMethod::Stop { operation: LifecycleOperation::Stop }, deadline) => {
                    if matches!(result, Ok(SystemValue::StopAcknowledged)) { GracefulStopResult::Requested }
                    else { GracefulStopResult::Rejected }
                }
            }
        })
    }
}

impl ProtocolTasks {
    pub(super) fn remaining(&self) -> Vec<crate::extensions::invocation::ResourcePartFailure> {
        [
            self.reader.remaining("protocol_reader"),
            self.writer.remaining("protocol_writer"),
            self.stderr.remaining("private_stderr"),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    pub(super) async fn close_checked(
        &mut self,
        session: &Session,
        deadline: Instant,
    ) -> Result<(), Arc<ProcessError>> {
        // Containment is already confirmed stopped. Cancellation closes inherited pipes;
        // only checked joins release custody, independently of the task's business outcome.
        self.reader.cancel();
        self.writer.cancel();
        self.stderr.cancel();
        let mut incomplete = None;
        for (task, stage) in [
            (&mut self.reader, CloseStage::ReaderJoin),
            (&mut self.writer, CloseStage::WriterJoin),
        ] {
            match task.join_checked(stage, deadline).await {
                Ok(Ok(_)) => {}
                Ok(Err(cause)) => session.fail(cause.clone()),
                Err(cause) => {
                    let pending = matches!(cause, CloseFailure::Deadline(_));
                    let cause = Arc::new(ProcessError::Close(Arc::new(cause)));
                    session.fail(cause.clone());
                    if pending {
                        incomplete.get_or_insert(cause);
                    }
                }
            }
        }
        match self
            .stderr
            .join_checked(CloseStage::StderrJoin, deadline)
            .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(cause)) => session.fail(Arc::new(ProcessError::Stderr(cause.clone()))),
            Err(cause) => {
                let pending = matches!(cause, CloseFailure::Deadline(_));
                let cause = Arc::new(ProcessError::Close(Arc::new(cause)));
                session.fail(cause.clone());
                if pending {
                    incomplete.get_or_insert(cause);
                }
            }
        }
        match incomplete {
            Some(cause) => Err(cause),
            None => Ok(()),
        }
    }
}
