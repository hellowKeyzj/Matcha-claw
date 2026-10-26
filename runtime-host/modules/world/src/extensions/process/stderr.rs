use std::{
    io,
    sync::{Arc, Mutex},
};

use foundation::{execution::OwnedTask, process::ProcessOutput};
use tokio::io::AsyncReadExt;
use zeroize::Zeroizing;

const TAIL_BYTES: usize = 64 * 1024;

/// Private diagnostics only. This type deliberately has no Debug or wire projection.
pub(super) struct StderrCapture {
    tail: Zeroizing<Vec<u8>>,
    position: usize,
    observed: u64,
}

impl StderrCapture {
    pub(super) fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            tail: Zeroizing::new(vec![0; TAIL_BYTES]),
            position: 0,
            observed: 0,
        }))
    }

    fn append(&mut self, bytes: &[u8]) {
        self.observed = self.observed.saturating_add(bytes.len() as u64);
        let first = bytes.len().min(TAIL_BYTES - self.position);
        self.tail[self.position..self.position + first].copy_from_slice(&bytes[..first]);
        let rest = bytes.len() - first;
        self.tail[..rest].copy_from_slice(&bytes[first..]);
        self.position = (self.position + bytes.len()) % TAIL_BYTES;
    }
}

pub(super) enum StderrEnd {
    Eof,
    Cancelled,
}

pub(super) type StderrResult = Result<StderrEnd, Arc<io::Error>>;

pub(super) fn collect(
    mut output: ProcessOutput,
    capture: Arc<Mutex<StderrCapture>>,
    completed: impl FnOnce(Option<Arc<io::Error>>) + Send + 'static,
) -> OwnedTask<StderrResult> {
    let (task, _) = OwnedTask::spawn(move |cancellation| async move {
        let result = async {
            let mut buffer = Zeroizing::new([0_u8; 8192]);
            loop {
                let count = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(StderrEnd::Cancelled),
                    result = output.read(&mut buffer[..]) => result?,
                };
                if count == 0 {
                    return Ok(StderrEnd::Eof);
                }
                capture
                    .lock()
                    .expect("process stderr capture lock poisoned")
                    .append(&buffer[..count]);
            }
        }
        .await
        .map_err(Arc::new);
        completed(result.as_ref().err().cloned());
        result
    });
    task
}
