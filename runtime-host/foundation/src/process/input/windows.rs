#[path = "windows/console.rs"]
mod console;

use std::{
    io,
    os::windows::io::{AsHandle, AsRawHandle, OwnedHandle},
    pin::Pin,
    ptr::null_mut,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, ready},
    thread::{self, JoinHandle},
};

use tokio::{
    io::{AsyncRead, ReadBuf},
    sync::mpsc,
};
use windows_sys::Win32::{
    Foundation as F, Storage::FileSystem::ReadFile, System::IO::CancelSynchronousIo,
};

/// Owns this process's standard-input reader; close joins its only native reader thread.
pub struct StdinReader {
    receiver: mpsc::Receiver<io::Result<Vec<u8>>>,
    buffer: Vec<u8>,
    offset: usize,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl StdinReader {
    pub fn open() -> io::Result<Self> {
        let input = io::stdin().as_handle().try_clone_to_owned()?;
        let (sender, receiver) = mpsc::channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let reader = thread::Builder::new()
            .name("stdin-reader".into())
            .spawn(move || read_stdin(input, sender, stopped))?;
        Ok(Self {
            receiver,
            buffer: Vec::new(),
            offset: 0,
            stop,
            reader: Some(reader),
        })
    }

    pub fn close(&mut self) -> io::Result<()> {
        self.receiver.close();
        self.stop.store(true, Ordering::Release);
        let Some(reader) = self.reader.as_ref() else {
            return Ok(());
        };
        let mut cancel_error = None;
        while !reader.is_finished() {
            // SAFETY: the JoinHandle keeps this exact reader thread's native handle alive.
            if unsafe { CancelSynchronousIo(reader.as_raw_handle() as _) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(F::ERROR_NOT_FOUND as i32) && cancel_error.is_none() {
                    cancel_error = Some(error);
                }
            }
            // ERROR_NOT_FOUND can precede ReadFile registration after the stop check.
            // Reissue cancellation until the thread has really exited, not just until no IO is pending.
            thread::yield_now();
        }
        self.reader
            .take()
            .expect("owned stdin reader")
            .join()
            .map_err(|_| io::Error::other("standard input reader panicked"))?;
        match cancel_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn read_stdin(input: OwnedHandle, sender: mpsc::Sender<io::Result<Vec<u8>>>, stop: Arc<AtomicBool>) {
    let mut console = console::ConsoleInput::open(&input);
    while !stop.load(Ordering::Acquire) {
        let bytes = match console.as_mut() {
            Some(console) => console.read(&input, &stop),
            None => read_bytes(&input),
        };
        if stop.load(Ordering::Acquire) {
            break;
        }
        match bytes {
            Ok(bytes) if bytes.is_empty() => break,
            Ok(bytes) => {
                if sender.blocking_send(Ok(bytes)).is_err() {
                    break;
                }
            }
            Err(error) => {
                if !matches!(error.raw_os_error(), Some(code)
                    if code == F::ERROR_BROKEN_PIPE as i32 || code == F::ERROR_HANDLE_EOF as i32)
                {
                    let _ = sender.blocking_send(Err(error));
                }
                break;
            }
        }
    }
}

fn read_bytes(input: &OwnedHandle) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0_u8; 8192];
    let mut read = 0;
    // SAFETY: the reader owns input; bytes and read remain writable for the synchronous call.
    if unsafe {
        ReadFile(
            input.as_raw_handle() as _,
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            &mut read,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    bytes.truncate(read as usize);
    Ok(bytes)
}

impl AsyncRead for StdinReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.offset == self.buffer.len() {
            self.buffer.clear();
            self.offset = 0;
            match ready!(self.receiver.poll_recv(context)) {
                Some(Ok(bytes)) => self.buffer = bytes,
                Some(Err(error)) => return Poll::Ready(Err(error)),
                None => return Poll::Ready(Ok(())),
            }
        }
        let count = buffer.remaining().min(self.buffer.len() - self.offset);
        buffer.put_slice(&self.buffer[self.offset..self.offset + count]);
        self.offset += count;
        Poll::Ready(Ok(()))
    }
}

impl Drop for StdinReader {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
