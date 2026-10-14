use std::{
    fs::File,
    io::{self, Read},
    os::{
        fd::{AsFd, AsRawFd},
        unix::fs::{FileTypeExt, MetadataExt},
    },
    pin::Pin,
    task::{Context, Poll, ready},
};

use tokio::io::{AsyncRead, ReadBuf, unix::AsyncFd};

/// Owns this process's standard-input reader; no other stdin consumer may run alongside it.
pub struct StdinReader {
    input: Option<Input>,
}

enum Input {
    Pollable(AsyncFd<NonblockingInput>),
    File(File),
}

impl StdinReader {
    pub fn open() -> io::Result<Self> {
        let file = File::from(io::stdin().as_fd().try_clone_to_owned()?);
        let metadata = file.metadata()?;
        let immediate = metadata.is_file()
            || (metadata.file_type().is_char_device()
                && metadata.rdev() == std::fs::metadata("/dev/null")?.rdev());
        let input = if immediate {
            // Regular files and /dev/null cannot use epoll. Preserve their finite synchronous read.
            Input::File(file)
        } else {
            let file = NonblockingInput::open(file)?;
            let file = AsyncFd::try_new(file).map_err(|error| {
                let (mut file, error) = error.into_parts();
                file.restore_flags().err().unwrap_or(error)
            })?;
            Input::Pollable(file)
        };
        Ok(Self { input: Some(input) })
    }

    pub fn close(&mut self) -> io::Result<()> {
        if let Some(Input::Pollable(file)) = self.input.as_mut() {
            file.get_mut().restore_flags()?;
        }
        self.input.take();
        Ok(())
    }
}

impl AsyncRead for StdinReader {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        match self.input.as_ref() {
            None => Poll::Ready(Ok(())),
            Some(Input::File(file)) => Poll::Ready(read_into(file, buffer)),
            Some(Input::Pollable(file)) => loop {
                let mut ready = ready!(file.poll_read_ready(context))?;
                match ready.try_io(|file| read_into(&file.get_ref().file, buffer)) {
                    Ok(result) => return Poll::Ready(result),
                    Err(_) => continue,
                }
            },
        }
    }
}

struct NonblockingInput {
    file: File,
    original_flags: Option<libc::c_int>,
}

impl NonblockingInput {
    fn open(file: File) -> io::Result<Self> {
        // dup shares status flags with the original stdin and any inherited reader.
        // SAFETY: file owns the live descriptor for both fcntl calls.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        let original_flags = (flags & libc::O_NONBLOCK == 0).then_some(flags);
        if original_flags.is_some()
            && unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            file,
            original_flags,
        })
    }

    fn restore_flags(&mut self) -> io::Result<()> {
        if let Some(flags) = self.original_flags {
            // SAFETY: this owner retains the descriptor through restoration and deregistration.
            if unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_SETFL, flags) } == -1 {
                return Err(io::Error::last_os_error());
            }
            self.original_flags = None;
        }
        Ok(())
    }
}

impl AsRawFd for NonblockingInput {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.file.as_raw_fd()
    }
}

impl Drop for NonblockingInput {
    fn drop(&mut self) {
        let _ = self.restore_flags();
    }
}

fn read_into(mut file: &File, buffer: &mut ReadBuf<'_>) -> io::Result<()> {
    loop {
        match file.read(buffer.initialize_unfilled()) {
            Ok(read) => {
                buffer.advance(read);
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

impl Drop for StdinReader {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
