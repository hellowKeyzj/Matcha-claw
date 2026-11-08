use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use platform::state_dir::CanonicalStateDir;
use tokio::sync::Mutex as AsyncMutex;

use super::logs::{LogStream, MAX_TAIL_ENTRY_BYTES, MAX_TAIL_LINES, sanitize_log_line_bounded};

const FILE_NAME: &str = "openclaw-lifecycle.log";
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const HISTORY_FILES: usize = 3;
const MAX_PENDING_BYTES: usize = 128 * 1024;
const TAIL_READ_BYTES: usize = MAX_TAIL_LINES * (MAX_TAIL_ENTRY_BYTES + 1);

#[derive(Clone, Copy)]
pub(crate) enum LifecycleProcess {
    Gateway(u32),
    Doctor(Option<u32>),
}

pub(crate) fn format_line(
    process: Option<LifecycleProcess>,
    stream: LogStream,
    bytes: &[u8],
) -> String {
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let process = match process {
        Some(LifecycleProcess::Gateway(pid)) => format!("gateway pid={pid}"),
        Some(LifecycleProcess::Doctor(Some(pid))) => format!("doctor pid={pid}"),
        Some(LifecycleProcess::Doctor(None)) => "doctor".to_owned(),
        None => "lifecycle".to_owned(),
    };
    let stream = match stream {
        LogStream::Stdout => "stdout",
        LogStream::Stderr => "stderr",
    };
    let mut record = format!("{timestamp} [{process} {stream}] ");
    record.push_str(&sanitize_log_line_bounded(
        bytes,
        MAX_TAIL_ENTRY_BYTES - record.len(),
    ));
    record
}

#[derive(Default)]
struct Pending {
    bytes: String,
    dropped: u64,
    disabled: bool,
    notice: Option<&'static str>,
}

#[derive(Clone)]
pub(crate) struct LifecycleJournal {
    pending: Arc<Mutex<Pending>>,
    file: Arc<AsyncMutex<JournalFile>>,
}

struct JournalFile {
    state_dir: CanonicalStateDir,
}

impl LifecycleJournal {
    pub(crate) fn new(state_dir: CanonicalStateDir) -> Self {
        Self {
            pending: Arc::new(Mutex::new(Pending::default())),
            file: Arc::new(AsyncMutex::new(JournalFile { state_dir })),
        }
    }

    pub(crate) fn append(&self, sanitized_line: &str) {
        let mut pending = self
            .pending
            .lock()
            .expect("OpenClaw journal mutex poisoned");
        if pending.disabled {
            return;
        }
        if pending.bytes.len() + sanitized_line.len() + 1 > MAX_PENDING_BYTES {
            pending.dropped = pending.dropped.saturating_add(1);
            return;
        }
        pending.bytes.push_str(sanitized_line);
        pending.bytes.push('\n');
    }

    pub(crate) async fn read_tail(&self) -> (Vec<(LogStream, String)>, bool) {
        let file = self.file.clone().lock_owned().await;
        match tokio::task::spawn_blocking(move || read_tail(&file.state_dir)).await {
            Ok(Ok(tail)) => tail,
            Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => (Vec::new(), false),
            _ => {
                eprintln!(
                    "[openclaw-journal] action=read-tail failed; retained in-memory logs remain available"
                );
                (Vec::new(), false)
            }
        }
    }

    pub(crate) async fn flush(&self) -> Option<&'static str> {
        let file = self.file.clone().lock_owned().await;
        let (bytes, dropped) = {
            let mut pending = self
                .pending
                .lock()
                .expect("OpenClaw journal mutex poisoned");
            if pending.disabled || (pending.bytes.is_empty() && pending.dropped == 0) {
                return pending.notice.take();
            }
            (
                std::mem::take(&mut pending.bytes),
                std::mem::take(&mut pending.dropped),
            )
        };
        let state = Arc::clone(&self.pending);
        let result = tokio::task::spawn_blocking(move || {
            let result = file.persist(&bytes, dropped);
            let mut pending = state.lock().expect("OpenClaw journal mutex poisoned");
            match result {
                Ok(()) if dropped > 0 => pending.notice = Some(
                    "[openclaw-journal] pending batch truncated; omitted-line count recorded in the journal",
                ),
                Ok(()) => {}
                Err(error) => {
                    eprintln!(
                        "[openclaw-journal] action=persist error_kind={:?} os_error={:?}; persistence disabled until Host restart; Gateway execution continues",
                        error.kind(), error.raw_os_error(),
                    );
                    pending.disabled = true;
                    pending.bytes.clear();
                    pending.dropped = 0;
                    pending.notice = Some("[openclaw-journal] persistence disabled until Host restart; check state directory permissions and free disk space; Gateway execution continues");
                }
            }
        }).await;
        let mut pending = self
            .pending
            .lock()
            .expect("OpenClaw journal mutex poisoned");
        if result.is_err() {
            eprintln!(
                "[openclaw-journal] action=persist worker failed; persistence disabled until Host restart; Gateway execution continues"
            );
            pending.disabled = true;
            pending.bytes.clear();
            pending.dropped = 0;
            pending.notice = Some(
                "[openclaw-journal] persistence worker failed; disabled until Host restart; Gateway execution continues",
            );
        }
        pending.notice.take()
    }
}

impl JournalFile {
    fn persist(&self, batch: &str, dropped: u64) -> io::Result<()> {
        self.state_dir
            .open()
            .map_err(|_| io::ErrorKind::PermissionDenied)?;
        let directory = CanonicalStateDir::provision_private(self.state_dir.as_path().join("logs"))
            .map_err(|_| io::ErrorKind::PermissionDenied)?;
        let path = directory.as_path().join(FILE_NAME);
        let mut file = open_append(&path)?;
        let mut length = file.metadata()?.len();
        if length > MAX_FILE_BYTES as u64 {
            drop(file);
            rotate(directory.as_path())?;
            file = open_append(&path)?;
            length = 0;
        }
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        let coverage = (dropped > 0).then(|| {
            format_line(
                None,
                LogStream::Stderr,
                format!(
                    "[openclaw-journal] omitted_lines={dropped} pending batch exceeded its bound"
                )
                .as_bytes(),
            )
        });
        for line in coverage.as_deref().into_iter().chain(batch.lines()) {
            let bytes = line.len() as u64 + 1;
            if length + bytes > MAX_FILE_BYTES as u64 {
                writer.flush()?;
                drop(writer);
                rotate(directory.as_path())?;
                writer = BufWriter::with_capacity(64 * 1024, open_append(&path)?);
                length = 0;
            }
            writer.write_all(line.as_bytes())?;
            writer.write_all(b"\n")?;
            length += bytes;
        }
        // Flush userspace buffering, not fsync: each producer awaits one bounded blocking batch.
        writer.flush()
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.file_type().is_symlink() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(file)
}

fn history_path(directory: &Path, history: usize) -> PathBuf {
    directory.join(if history == 0 {
        FILE_NAME.to_owned()
    } else {
        format!("{FILE_NAME}.{history}")
    })
}

fn rotate(directory: &Path) -> io::Result<()> {
    match fs::remove_file(history_path(directory, HISTORY_FILES)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    for history in (0..HISTORY_FILES).rev() {
        match fs::rename(
            history_path(directory, history),
            history_path(directory, history + 1),
        ) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn decode_record(bytes: &[u8]) -> Option<(LogStream, String)> {
    let line = std::str::from_utf8(bytes).ok()?;
    let (prefix, body) = line.split_once("] ")?;
    let (timestamp, context) = prefix.split_once(" [")?;
    chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
    let (process, stream) = context.rsplit_once(' ')?;
    match process {
        "lifecycle" | "doctor" => {}
        _ => {
            process
                .strip_prefix("gateway pid=")
                .or_else(|| process.strip_prefix("doctor pid="))?
                .parse::<u32>()
                .ok()?;
        }
    }
    let stream = match stream {
        "stdout" => LogStream::Stdout,
        "stderr" => LogStream::Stderr,
        _ => return None,
    };
    let mut record = format!("{prefix}] ");
    let limit = MAX_TAIL_ENTRY_BYTES.checked_sub(record.len())?;
    if limit < 4 {
        return None;
    }
    record.push_str(&sanitize_log_line_bounded(body.as_bytes(), limit));
    Some((stream, record))
}

fn read_tail(state_dir: &CanonicalStateDir) -> io::Result<(Vec<(LogStream, String)>, bool)> {
    state_dir
        .open()
        .map_err(|_| io::ErrorKind::PermissionDenied)?;
    let directory = CanonicalStateDir::open_existing(state_dir.as_path().join("logs"))
        .map_err(|_| io::ErrorKind::NotFound)?;
    let mut tail = VecDeque::new();
    let mut evicted = false;
    for history in 0..=HISTORY_FILES {
        let name = if history == 0 {
            FILE_NAME.to_owned()
        } else {
            format!("{FILE_NAME}.{history}")
        };
        let mut file = match directory.open_regular_file_readonly(&name) {
            Ok(Some(file)) => file,
            Ok(None) => continue,
            Err(_) => return Err(io::ErrorKind::PermissionDenied.into()),
        };
        let length = file.metadata()?.len();
        let offset = length.saturating_sub(TAIL_READ_BYTES as u64);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::with_capacity(TAIL_READ_BYTES);
        file.take(TAIL_READ_BYTES as u64).read_to_end(&mut bytes)?;
        let bytes = if offset > 0 {
            evicted = true;
            bytes
                .splitn(2, |byte| *byte == b'\n')
                .nth(1)
                .unwrap_or_default()
        } else {
            &bytes
        };
        for line in bytes
            .split(|byte| *byte == b'\n')
            .rev()
            .filter(|line| !line.is_empty())
        {
            if tail.len() == MAX_TAIL_LINES {
                evicted = true;
                return Ok((tail.into_iter().collect(), evicted));
            }
            if let Some(entry) = decode_record(line) {
                tail.push_front(entry);
            } else {
                evicted = true;
            }
        }
    }
    Ok((tail.into_iter().collect(), evicted))
}
