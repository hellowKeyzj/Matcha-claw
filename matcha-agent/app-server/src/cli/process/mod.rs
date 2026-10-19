use std::{
    collections::BTreeMap,
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};

use serde_json::json;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{Mutex, mpsc},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;

use crate::rpc;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

const RESOURCE_WINDOW: Duration = Duration::from_secs(5);
const READ_BYTES: usize = 16 * 1024;
// At most 1 MiB of stdout chunks, not a session/output-size limit. Six slots are
// reserved for stream/exit facts so a stalled consumer cannot prevent close.
const OUTPUT_SLOTS: usize = 64;

// This environment is already resolved and complete; never derive Debug here.
pub struct Launch {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

pub enum Output {
    Stdout(Vec<u8>),
    StdoutClosed,
    // Coalesced once per child: stderr was observed, never its contents.
    Stderr,
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    ReadFailed {
        stream: &'static str,
        kind: String,
    },
}

#[derive(Clone)]
pub struct Process(Arc<Control>);

struct Control {
    input: Arc<Mutex<Option<platform::Input>>>,
    input_closed: CancellationToken,
    closing: CancellationToken,
    pid: Arc<AtomicU32>,
    graceful_exit: Arc<AtomicBool>,
    completion: Mutex<Completion>,
}

enum Completion {
    Running(JoinHandle<rpc::Result<()>>),
    Finished(rpc::Result<()>),
}

impl Drop for Control {
    fn drop(&mut self) {
        self.input_closed.cancel();
        self.closing.cancel();
    }
}

impl Process {
    pub async fn spawn(launch: Launch) -> rpc::Result<(Self, mpsc::Receiver<Output>)> {
        let platform::Spawned {
            child,
            stdin,
            stdout,
            stderr,
        } = platform::spawn(launch).await?;
        let (output, receiver) = mpsc::channel(OUTPUT_SLOTS);
        // The receiver is still local; these reservations cannot fail.
        let stdout_end = output.clone().try_reserve_owned().expect("local receiver");
        let stderr_seen = output.clone().try_reserve_owned().expect("local receiver");
        let stderr_end = output.clone().try_reserve_owned().expect("local receiver");
        let exit_error = output.clone().try_reserve_owned().expect("local receiver");
        let cleanup_error = output.clone().try_reserve_owned().expect("local receiver");
        let exit = output.clone().try_reserve_owned().expect("local receiver");
        let input = Arc::new(Mutex::new(Some(stdin)));
        let input_closed = CancellationToken::new();
        let closing = CancellationToken::new();
        let pid = Arc::new(AtomicU32::new(child.pid()));
        let graceful_exit = Arc::new(AtomicBool::new(false));
        let stop_reading = CancellationToken::new();
        let stdout_task = tokio::spawn(read_stdout(
            stdout,
            output.clone(),
            stdout_end,
            stop_reading.clone(),
        ));
        let stderr_task = tokio::spawn(read_stderr(
            stderr,
            stderr_seen,
            stderr_end,
            stop_reading.clone(),
        ));
        let task = tokio::spawn(finish(
            child,
            input.clone(),
            input_closed.clone(),
            closing.clone(),
            pid.clone(),
            graceful_exit.clone(),
            output,
            stdout_task,
            stderr_task,
            stop_reading,
            exit_error,
            cleanup_error,
            exit,
        ));
        Ok((
            Self(Arc::new(Control {
                input,
                input_closed,
                closing,
                pid,
                graceful_exit,
                completion: Mutex::new(Completion::Running(task)),
            })),
            receiver,
        ))
    }

    pub fn pid(&self) -> Option<u32> {
        match self.0.pid.load(Ordering::Acquire) {
            0 => None,
            pid => Some(pid),
        }
    }

    pub fn exited_gracefully(&self) -> bool {
        self.0.graceful_exit.load(Ordering::Acquire)
    }

    // Bytes include their caller-owned framing/LF; successful writing is not CLI ACK.
    pub async fn send(&self, bytes: Vec<u8>) -> rpc::Result<()> {
        let closed = &self.0.input_closed;
        let mut input = tokio::select! {
            biased;
            _ = closed.cancelled() => return Err(write_closed(false)),
            input = self.0.input.lock() => input,
        };
        if input.is_none() || closed.is_cancelled() {
            return Err(write_closed(false));
        }
        // Dropping a cancelled send future must close a potentially partial frame.
        let mut abandoned = AbandonedWrite {
            input: &mut input,
            closed,
            complete: false,
        };
        let writer = abandoned.input.as_mut().expect("open stdin");
        // Once the write future has been polled, cancellation/error cannot prove
        // that no bytes reached the child. Do not turn partial sends into retries.
        let result = tokio::select! {
            biased;
            _ = closed.cancelled() => Err(write_closed(true)),
            result = async {
                writer.write_all(&bytes).await?;
                writer.flush().await
            } => result.map_err(|error| {
                let kind = if error.kind() == io::ErrorKind::BrokenPipe {
                    "stdin_broken_pipe"
                } else {
                    "stdin_write_failed"
                };
                let mut failure = io_failure(kind, "CLI stdin write failed", error)
                    .with_data(json!({ "delivery": "unknown" }));
                failure.code = -32006;
                failure
            }),
        };
        abandoned.complete = result.is_ok();
        result
    }

    pub async fn finish_input(&self) -> rpc::Result<()> {
        self.0.input_closed.cancel();
        self.0.input.lock().await.take();
        Ok(())
    }

    pub async fn close(&self) -> rpc::Result<()> {
        self.0.input_closed.cancel();
        self.0.closing.cancel();
        let mut completion = self.0.completion.lock().await;
        if let Completion::Running(task) = &mut *completion {
            let result = task.await.unwrap_or_else(|error| {
                Err(rpc::Error::new(
                    -32004,
                    "process_join_failed",
                    "CLI process resource task did not finish normally",
                )
                .with_source(error))
            });
            *completion = Completion::Finished(result);
        }
        match &*completion {
            Completion::Finished(result) => result.clone(),
            Completion::Running(_) => unreachable!("joined resource task"),
        }
    }
}

struct AbandonedWrite<'a> {
    input: &'a mut Option<platform::Input>,
    closed: &'a CancellationToken,
    complete: bool,
}

impl Drop for AbandonedWrite<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.closed.cancel();
            self.input.take();
        }
    }
}

fn write_closed(started: bool) -> rpc::Error {
    rpc::Error::new(
        if started { -32006 } else { -32004 },
        if started {
            "stdin_write_cancelled"
        } else {
            "stdin_closed"
        },
        "CLI stdin is closed",
    )
    .with_data(json!({ "delivery": if started { "unknown" } else { "notSent" } }))
}

pub(super) fn io_failure(
    kind: &'static str,
    message: &'static str,
    error: io::Error,
) -> rpc::Error {
    rpc::Error::new(-32004, kind, message)
        .with_data(
            json!({ "ioKind": format!("{:?}", error.kind()), "osCode": error.raw_os_error() }),
        )
        .with_source(error)
}

async fn read_stdout(
    mut stream: impl AsyncRead + Unpin,
    output: mpsc::Sender<Output>,
    end: mpsc::OwnedPermit<Output>,
    stop: CancellationToken,
) -> rpc::Result<()> {
    let result = async {
        loop {
            // Reserve before reading: every byte already read has a queue slot.
            let permit = tokio::select! {
                biased;
                _ = stop.cancelled() => return Err(drain_timeout("stdout")),
                permit = output.reserve() => match permit {
                    Ok(permit) => permit,
                    Err(_) => return Ok(()),
                },
            };
            let mut bytes = vec![0; READ_BYTES];
            let read = tokio::select! {
                biased;
                _ = stop.cancelled() => return Err(drain_timeout("stdout")),
                read = stream.read(&mut bytes) => read,
            }
            .map_err(|error| io_failure("stdout_read_failed", "CLI stdout read failed", error))?;
            if read == 0 {
                return Ok(());
            }
            bytes.truncate(read);
            permit.send(Output::Stdout(bytes));
        }
    }
    .await;
    match &result {
        Ok(()) => {
            end.send(Output::StdoutClosed);
        }
        Err(error) => {
            end.send(Output::ReadFailed {
                stream: "stdout",
                kind: error_kind(error),
            });
        }
    }
    result
}

async fn read_stderr(
    mut stream: impl AsyncRead + Unpin,
    seen: mpsc::OwnedPermit<Output>,
    end: mpsc::OwnedPermit<Output>,
    stop: CancellationToken,
) -> rpc::Result<()> {
    let mut seen = Some(seen);
    let mut bytes = [0; READ_BYTES];
    let result = async {
        loop {
            let read = tokio::select! {
                biased;
                _ = stop.cancelled() => return Err(drain_timeout("stderr")),
                read = stream.read(&mut bytes) => read,
            }
            .map_err(|error| io_failure("stderr_read_failed", "CLI stderr read failed", error))?;
            // Never retain stderr as a String, tail, source or event payload.
            bytes.fill(0);
            if read == 0 {
                return Ok(());
            }
            if let Some(permit) = seen.take() {
                permit.send(Output::Stderr);
            }
        }
    }
    .await;
    bytes.fill(0);
    if let Err(error) = &result {
        end.send(Output::ReadFailed {
            stream: "stderr",
            kind: error_kind(error),
        });
    }
    result
}

fn drain_timeout(stream: &'static str) -> rpc::Error {
    rpc::Error::new(
        -32004,
        "stdio_drain_timeout",
        "CLI output did not drain during resource cleanup",
    )
    .with_data(json!({ "stream": stream, "unreadTail": true }))
}

fn error_kind(error: &rpc::Error) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("kind"))
        .and_then(serde_json::Value::as_str)
        .expect("process error kind")
        .to_owned()
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    mut child: platform::Child,
    input: Arc<Mutex<Option<platform::Input>>>,
    input_closed: CancellationToken,
    closing: CancellationToken,
    pid: Arc<AtomicU32>,
    graceful_exit: Arc<AtomicBool>,
    output: mpsc::Sender<Output>,
    stdout: JoinHandle<rpc::Result<()>>,
    stderr: JoinHandle<rpc::Result<()>>,
    stop_reading: CancellationToken,
    exit_error: mpsc::OwnedPermit<Output>,
    cleanup_error: mpsc::OwnedPermit<Output>,
    exit: mpsc::OwnedPermit<Output>,
) -> rpc::Result<()> {
    let mut failures = Vec::new();
    let observed_exit = tokio::select! {
        result = child.exited() => Some(result),
        _ = closing.cancelled() => None,
        _ = output.closed() => None,
    };
    let drain_deadline = observed_exit
        .is_none()
        .then(|| Instant::now() + RESOURCE_WINDOW);
    input_closed.cancel();
    input.lock().await.take();
    let natural_exit = match observed_exit {
        Some(Err(error)) => {
            failures.push(error);
            false
        }
        Some(Ok(())) => true,
        None => match timeout(RESOURCE_WINDOW, child.exited()).await {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                failures.push(error);
                false
            }
            Err(_) => false, // Resource grace window, not a business deadline.
        },
    };

    let forced = match child.terminate_tree() {
        Ok(forced) => forced,
        Err(error) => {
            failures.push(error);
            true
        }
    };
    let status = match timeout(RESOURCE_WINDOW, child.wait()).await {
        Ok(Ok(status)) => {
            pid.store(0, Ordering::Release);
            Some(status)
        }
        Ok(Err(error)) => {
            exit_error.send(Output::ReadFailed {
                stream: "process",
                kind: error_kind(&error),
            });
            failures.push(error);
            None
        }
        Err(_) => {
            let error = rpc::Error::new(
                -32004,
                "process_wait_timeout",
                "CLI exit was not confirmed after tree cleanup",
            );
            exit_error.send(Output::ReadFailed {
                stream: "process",
                kind: error_kind(&error),
            });
            failures.push(error);
            None
        }
    };
    if let Err(error) = child.confirm_cleanup().await {
        failures.push(error);
    }
    // Successful natural exit has no consumer deadline. Explicit close and
    // failed physical cleanup bound unread I/O, never already-reserved chunks.
    let readers = async { tokio::join!(stdout, stderr) };
    tokio::pin!(readers);
    let drain_deadline =
        drain_deadline.or_else(|| (!failures.is_empty()).then(|| Instant::now() + RESOURCE_WINDOW));
    let drained = if drain_deadline.is_some() {
        None
    } else {
        tokio::select! {
            joined = &mut readers => Some(joined),
            _ = closing.cancelled() => None,
            _ = output.closed() => None,
        }
    };
    let joined = match drained {
        Some(joined) => joined,
        None => match timeout_at(
            drain_deadline.unwrap_or_else(|| Instant::now() + RESOURCE_WINDOW),
            &mut readers,
        )
        .await
        {
            Ok(joined) => joined,
            Err(_) => {
                stop_reading.cancel();
                readers.await
            }
        },
    };
    for result in [joined.0, joined.1] {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(error),
            Err(error) => failures.push(
                rpc::Error::new(
                    -32004,
                    "stdio_join_failed",
                    "CLI output reader did not finish normally",
                )
                .with_source(error),
            ),
        }
    }
    graceful_exit.store(
        natural_exit && !forced && status == Some((Some(0), None)) && failures.is_empty(),
        Ordering::Release,
    );
    if !failures.is_empty() {
        cleanup_error.send(Output::ReadFailed {
            stream: "cleanup",
            kind: error_kind(&failures[0]),
        });
    }
    // Reader joins happen before this send, so final result bytes/EOF cannot be
    // overtaken by OS exit even when the consumer is slow.
    if let Some((code, signal)) = status {
        exit.send(Output::Exited { code, signal });
    }
    drop(child);
    if failures.is_empty() {
        Ok(())
    } else {
        let causes = failures
            .iter()
            .map(|error| json!({ "code": error.code, "data": error.data }))
            .collect::<Vec<_>>();
        let primary = failures[0].clone();
        Err(primary
            .with_data(json!({ "failures": causes }))
            .with_source(ProcessFailures(failures)))
    }
}

#[derive(Debug)]
struct ProcessFailures(Vec<rpc::Error>);

impl std::fmt::Display for ProcessFailures {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} CLI resource failure(s)", self.0.len())
    }
}

impl std::error::Error for ProcessFailures {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.first().map(|error| error as &dyn std::error::Error)
    }
}
