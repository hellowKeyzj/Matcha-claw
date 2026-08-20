use std::fs::File;
use std::io as stdio;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use crate::process::launch::posix::PosixLaunchCustody;

use super::super::super::{
    AuthorityScope, ExitObservation, LaunchSpec, ProcessIdentity, ProcessStdio, ScopeId,
    task::TaskOwner,
};
use super::guardian_process::{self, GuardianProcess};
use super::host_protocol::{
    decode_armed_payload, decode_exit_status_payload, encode_launch_payload, encode_stdio_spec,
};
use super::io::{read_frame, write_frame};
use super::protocol::{Frame, Message};
use super::stdio::HostStdio;

pub(super) const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_POLL_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustodyFailure {
    AuthorityLost,
    CleanupUnconfirmed,
    LaunchFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CustodyDrain {
    Pending,
    Drained(ExitObservation),
}

pub(crate) struct LaunchedCustody {
    root: ProcessIdentity,
    scope: AuthorityScope,
    stdio: ProcessStdio,
}

#[derive(Debug)]
pub(super) enum SpawnFailure {
    Launch(stdio::Error),
    AuthorityLost,
}

impl LaunchedCustody {
    pub(crate) const fn root_identity(&self) -> ProcessIdentity {
        self.root
    }

    pub(crate) const fn authority_scope(&self) -> AuthorityScope {
        self.scope
    }

    pub(crate) fn into_stdio(self) -> ProcessStdio {
        self.stdio
    }
}

struct ExchangeRequest {
    message: Message,
    payload: Vec<u8>,
    request_id: u64,
    drained_observation: Option<ExitObservation>,
}

impl ExchangeRequest {
    fn matches(&self, message: Message, payload: &[u8]) -> bool {
        self.message == message && self.payload.as_slice() == payload
    }
}

struct ExchangeTaskOutput {
    guardian: GuardianProcess,
    response: stdio::Result<Frame>,
}

impl ExchangeTaskOutput {
    fn exchange(
        guardian: GuardianProcess,
        message: Message,
        nonce: [u8; 16],
        request_id: u64,
        payload: Vec<u8>,
        deadline: Instant,
    ) -> Self {
        let response = Frame::new(message, nonce, request_id, payload).and_then(|request| {
            write_frame(guardian.stdin.as_raw_fd(), &request, deadline)?;
            read_frame(guardian.stdout.as_raw_fd(), deadline)
        });
        Self { guardian, response }
    }
}

pub(super) struct InFlightExchange {
    request: ExchangeRequest,
    task: TaskOwner<Result<ExchangeTaskOutput, tokio::task::JoinError>>,
}

struct CompletedExchange {
    request: ExchangeRequest,
    frame: Frame,
}

pub(crate) struct NativeCustody {
    pub(super) guardian: Option<GuardianProcess>,
    pub(super) nonce: [u8; 16],
    pub(super) next_request_id: u64,
    pub(super) in_flight: Option<InFlightExchange>,
}

impl NativeCustody {
    pub(super) async fn spawn(
        guardian_executable: &Path,
        spec: &LaunchSpec,
        custody: Option<PosixLaunchCustody>,
        private_descriptor: Option<std::os::fd::OwnedFd>,
        execution_source: Option<std::os::fd::OwnedFd>,
    ) -> Result<(Self, HostStdio), SpawnFailure> {
        let nonce = random_nonce().map_err(SpawnFailure::Launch)?;
        let host_stdio = HostStdio::create(spec.stdio()).map_err(SpawnFailure::Launch)?;
        let (guardian, host_stdio) = match guardian_process::spawn(
            guardian_executable,
            host_stdio,
            custody,
            private_descriptor,
            execution_source,
        ) {
            Ok(guardian) => guardian,
            Err(guardian_process::SpawnFailure::BeforeOwnership(error)) => {
                return Err(SpawnFailure::Launch(error));
            }
            Err(guardian_process::SpawnFailure::AfterOwnership) => {
                return Err(SpawnFailure::AuthorityLost);
            }
        };
        let mut custody = Self {
            guardian: Some(guardian),
            nonce,
            next_request_id: 1,
            in_flight: None,
        };
        let ready = custody
            .exchange(Message::Hello, encode_stdio_spec(spec.stdio()))
            .await;
        if !matches!(ready, Ok(frame) if frame.message == Message::Ready) {
            custody.relinquish();
            return Err(SpawnFailure::AuthorityLost);
        }
        Ok((custody, host_stdio))
    }

    pub(super) async fn launch(
        &mut self,
        spec: &LaunchSpec,
        host_stdio: HostStdio,
    ) -> Result<LaunchedCustody, CustodyFailure> {
        let payload = match encode_launch_payload(
            spec.executable().as_os_str(),
            spec.working_directory(),
            spec.arguments(),
            spec.public_environment(),
        ) {
            Ok(payload) => payload,
            Err(_) => {
                self.relinquish();
                return Err(CustodyFailure::AuthorityLost);
            }
        };
        let frame = self.exchange(Message::Launch, payload).await?;
        match frame.message {
            Message::Armed => {
                let (target_pid, creation_marker) = match decode_armed_payload(&frame.payload) {
                    Ok(observation) => observation,
                    Err(_) => {
                        self.relinquish();
                        return Err(CustodyFailure::AuthorityLost);
                    }
                };
                let root = ProcessIdentity::new(target_pid as u32, creation_marker);
                let scope = AuthorityScope::owned(scope_id(self.nonce, root));
                Ok(LaunchedCustody {
                    root,
                    scope,
                    stdio: host_stdio.into_process_stdio(),
                })
            }
            Message::LaunchFailed if frame.payload.is_empty() => {
                self.reap_confirmed()?;
                Err(CustodyFailure::LaunchFailed)
            }
            Message::CleanupUnconfirmed if frame.payload.is_empty() => {
                Err(CustodyFailure::CleanupUnconfirmed)
            }
            _ => {
                self.relinquish();
                Err(CustodyFailure::AuthorityLost)
            }
        }
    }

    pub(crate) async fn terminate(&mut self) -> Result<ExitObservation, CustodyFailure> {
        match self.exchange(Message::Terminate, Vec::new()).await {
            Ok(frame) if frame.message == Message::Terminate && frame.payload.is_empty() => {
                self.reap_confirmed()?;
                Ok(ExitObservation::new(None, None, SystemTime::now()))
            }
            Ok(frame)
                if frame.message == Message::CleanupUnconfirmed && frame.payload.is_empty() =>
            {
                Err(CustodyFailure::CleanupUnconfirmed)
            }
            Ok(_) | Err(_) => {
                self.relinquish();
                Err(CustodyFailure::AuthorityLost)
            }
        }
    }

    pub(crate) async fn poll_drained(&mut self) -> Result<CustodyDrain, CustodyFailure> {
        if self
            .in_flight
            .as_ref()
            .is_some_and(|exchange| exchange.request.message == Message::Disarm)
        {
            return self.resume_disarm().await;
        }
        let frame = self
            .exchange_until(
                Message::Drain,
                Vec::new(),
                Instant::now() + DRAIN_POLL_TIMEOUT,
            )
            .await?;
        self.record_drain(frame).await
    }

    #[cfg(test)]
    pub(super) fn guardian_pid(&self) -> Option<libc::pid_t> {
        self.guardian
            .as_ref()
            .map(|guardian| guardian.child.id() as libc::pid_t)
    }

    async fn exchange(
        &mut self,
        message: Message,
        payload: Vec<u8>,
    ) -> Result<Frame, CustodyFailure> {
        self.exchange_until(message, payload, Instant::now() + CONTROL_TIMEOUT)
            .await
    }

    async fn exchange_until(
        &mut self,
        message: Message,
        payload: Vec<u8>,
        deadline: Instant,
    ) -> Result<Frame, CustodyFailure> {
        if self.in_flight.is_some() {
            let completed = self.await_in_flight().await?;
            if completed.request.matches(message, &payload) {
                return Ok(completed.frame);
            }
            self.relinquish();
            return Err(CustodyFailure::AuthorityLost);
        }

        self.start_exchange(message, payload, deadline, None)?;
        Ok(self.await_in_flight().await?.frame)
    }

    fn start_exchange(
        &mut self,
        message: Message,
        payload: Vec<u8>,
        deadline: Instant,
        drained_observation: Option<ExitObservation>,
    ) -> Result<(), CustodyFailure> {
        let request_id = self.next_request_id;
        let Some(next_request_id) = self.next_request_id.checked_add(1) else {
            self.relinquish();
            return Err(CustodyFailure::AuthorityLost);
        };
        let guardian = self.guardian.take().ok_or(CustodyFailure::AuthorityLost)?;
        let nonce = self.nonce;
        let task_payload = payload.clone();
        let task = TaskOwner::spawn(async move {
            tokio::task::spawn_blocking(move || {
                ExchangeTaskOutput::exchange(
                    guardian,
                    message,
                    nonce,
                    request_id,
                    task_payload,
                    deadline,
                )
            })
            .await
        });
        self.next_request_id = next_request_id;
        self.in_flight = Some(InFlightExchange {
            request: ExchangeRequest {
                message,
                payload,
                request_id,
                drained_observation,
            },
            task,
        });
        Ok(())
    }

    async fn await_in_flight(&mut self) -> Result<CompletedExchange, CustodyFailure> {
        let joined = (&mut self
            .in_flight
            .as_mut()
            .expect("in-flight exchange must exist before it is awaited")
            .task)
            .await;
        let in_flight = self
            .in_flight
            .take()
            .expect("completed exchange must remain stored until it is recovered");
        let output = match joined {
            Ok(Ok(output)) => output,
            Ok(Err(_)) | Err(_) => return Err(CustodyFailure::AuthorityLost),
        };
        let ExchangeTaskOutput { guardian, response } = output;
        match response {
            Ok(frame)
                if frame.nonce == self.nonce
                    && frame.request_id == in_flight.request.request_id
                    && frame.message != Message::AuthorityLost =>
            {
                self.guardian = Some(guardian);
                Ok(CompletedExchange {
                    request: in_flight.request,
                    frame,
                })
            }
            Ok(_) | Err(_) => Err(CustodyFailure::AuthorityLost),
        }
    }

    async fn record_drain(&mut self, frame: Frame) -> Result<CustodyDrain, CustodyFailure> {
        match frame.message {
            Message::Pending => Ok(CustodyDrain::Pending),
            Message::Drained => {
                let observation = match exit_observation(&frame.payload) {
                    Ok(observation) => observation,
                    Err(error) => {
                        self.relinquish();
                        return Err(error);
                    }
                };
                self.start_exchange(
                    Message::Disarm,
                    Vec::new(),
                    Instant::now() + CONTROL_TIMEOUT,
                    Some(observation),
                )?;
                self.resume_disarm().await
            }
            _ => {
                self.relinquish();
                Err(CustodyFailure::AuthorityLost)
            }
        }
    }

    async fn resume_disarm(&mut self) -> Result<CustodyDrain, CustodyFailure> {
        let completed = self.await_in_flight().await?;
        let Some(observation) = completed.request.drained_observation else {
            self.relinquish();
            return Err(CustodyFailure::AuthorityLost);
        };
        if completed.request.message == Message::Disarm
            && completed.frame.message == Message::Disarm
            && completed.frame.payload.is_empty()
        {
            self.reap_confirmed()?;
            Ok(CustodyDrain::Drained(observation))
        } else if completed.frame.message == Message::CleanupUnconfirmed
            && completed.frame.payload.is_empty()
        {
            Err(CustodyFailure::CleanupUnconfirmed)
        } else {
            self.relinquish();
            Err(CustodyFailure::AuthorityLost)
        }
    }

    fn reap_confirmed(&mut self) -> Result<(), CustodyFailure> {
        let guardian = self.guardian.take().ok_or(CustodyFailure::AuthorityLost)?;
        guardian_process::reap(guardian).map_err(|_| CustodyFailure::AuthorityLost)
    }

    fn relinquish(&mut self) {
        self.guardian = None;
    }
}

fn random_nonce() -> stdio::Result<[u8; 16]> {
    let source = File::open("/dev/urandom")?;
    let mut nonce = [0_u8; 16];
    super::io::read_exact_until(
        source.as_raw_fd(),
        &mut nonce,
        Instant::now() + Duration::from_secs(1),
    )?;
    Ok(nonce)
}

fn exit_observation(payload: &[u8]) -> Result<ExitObservation, CustodyFailure> {
    let (exit_code, signal) =
        decode_exit_status_payload(payload).map_err(|_| CustodyFailure::AuthorityLost)?;
    Ok(ExitObservation::new(exit_code, signal, SystemTime::now()))
}

fn scope_id(nonce: [u8; 16], root: ProcessIdentity) -> ScopeId {
    let mut bytes = nonce;
    let root_pid = root.pid().to_be_bytes();
    let marker = root.creation_marker().to_be_bytes();
    for (index, byte) in root_pid.into_iter().chain(marker).enumerate() {
        bytes[index % bytes.len()] ^= byte;
    }
    ScopeId::new(bytes)
}
