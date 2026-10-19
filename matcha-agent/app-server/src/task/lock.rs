use std::{
    fs::{self, FileTimes, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::rpc;

const STALE: Duration = Duration::from_secs(10);
const UPDATE: Duration = Duration::from_secs(5);

struct Lease {
    mtime: u128,
    seconds: bool,
    last_update: SystemTime,
    stopped: bool,
    compromised: bool,
}

pub(super) struct Lock {
    path: PathBuf,
    shared: Arc<(Mutex<Lease>, Condvar)>,
    heartbeat: Option<JoinHandle<()>>,
    finished: bool,
}

impl Lock {
    pub(super) fn acquire(directory: &Path) -> rpc::Result<Self> {
        let target = directory.join(".lock");
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(super::files::io_error("task_io", error)),
        }
        if !super::files::metadata(&target)?.is_some_and(|metadata| metadata.is_file()) {
            return Err(super::native_invalid());
        }
        // proper-lockfile realpaths its target before appending the .lock suffix.
        let target =
            fs::canonicalize(target).map_err(|error| super::files::io_error("task_io", error))?;
        let mut path = target.into_os_string();
        path.push(".lock");
        let path = PathBuf::from(path);
        for attempt in 0..=30 {
            if acquire(&path, true)? {
                break;
            }
            if attempt == 30 {
                return Err(conflict());
            }
            thread::sleep(Duration::from_millis((5_u64 << attempt.min(5)).min(100)));
        }
        let probe = (millis(SystemTime::now())?.div_ceil(1000) * 1000) + 5;
        let mtime = match touch(&path, probe).and_then(|_| modified(&path)) {
            Ok(mtime) => mtime,
            Err(error) => {
                let _ = fs::remove_dir(&path);
                return Err(super::files::io_error("task_io", error));
            }
        };
        let shared = Arc::new((
            Mutex::new(Lease {
                mtime,
                seconds: mtime % 1000 == 0,
                last_update: SystemTime::now(),
                stopped: false,
                compromised: false,
            }),
            Condvar::new(),
        ));
        let worker_shared = shared.clone();
        let worker_path = path.clone();
        let heartbeat = match thread::Builder::new()
            .name("task-list-lock".into())
            .spawn(move || heartbeat(&worker_path, &worker_shared))
        {
            Ok(heartbeat) => heartbeat,
            Err(error) => {
                let _ = fs::remove_dir(&path);
                return Err(super::files::io_error("task_io", error));
            }
        };
        Ok(Self {
            path,
            shared,
            heartbeat: Some(heartbeat),
            finished: false,
        })
    }

    pub(super) fn verify(&self) -> rpc::Result<()> {
        let lease = self.shared.0.lock().expect("task lock lease");
        if lease.compromised || expired(lease.last_update) {
            return Err(conflict());
        }
        match modified(&self.path) {
            Ok(mtime) if mtime == lease.mtime => Ok(()),
            Ok(_) => Err(conflict()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(conflict()),
            Err(error) => Err(super::files::io_error("task_io", error)),
        }
    }

    pub(super) fn release(mut self) -> rpc::Result<()> {
        self.stop();
        self.finished = true;
        self.verify()?;
        fs::remove_dir(&self.path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                conflict()
            } else {
                super::files::io_error("task_io", error)
            }
        })
    }

    fn stop(&mut self) {
        {
            let mut lease = self.shared.0.lock().expect("task lock lease");
            lease.stopped = true;
            self.shared.1.notify_one();
        }
        if let Some(heartbeat) = self.heartbeat.take()
            && heartbeat.join().is_err()
        {
            self.shared.0.lock().expect("task lock lease").compromised = true;
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if !self.finished {
            self.stop();
            if self.verify().is_ok() {
                let _ = fs::remove_dir(&self.path);
            }
        }
    }
}

fn acquire(path: &Path, stale_check: bool) -> rpc::Result<bool> {
    match fs::create_dir(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !stale_check {
                return Ok(false);
            }
            let mtime = match modified(path) {
                Ok(mtime) => mtime,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return acquire(path, false);
                }
                Err(error) => return Err(super::files::io_error("task_io", error)),
            };
            if mtime.saturating_add(STALE.as_millis()) >= millis(SystemTime::now())? {
                return Ok(false);
            }
            match fs::remove_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(super::files::io_error("task_io", error)),
            }
            acquire(path, false)
        }
        Err(error) => Err(super::files::io_error("task_io", error)),
    }
}

fn heartbeat(path: &Path, shared: &(Mutex<Lease>, Condvar)) {
    let mut delay = UPDATE;
    let mut lease = shared.0.lock().expect("task lock lease");
    loop {
        let (next, _) = shared
            .1
            .wait_timeout_while(lease, delay, |lease| !lease.stopped)
            .expect("task lock heartbeat");
        lease = next;
        if lease.stopped {
            return;
        }
        match modified(path) {
            Ok(mtime) if mtime != lease.mtime => {
                lease.compromised = true;
                return;
            }
            Ok(_) => {}
            Err(error) => {
                if error.kind() == io::ErrorKind::NotFound || expired(lease.last_update) {
                    lease.compromised = true;
                    return;
                }
                delay = Duration::from_secs(1);
                continue;
            }
        }
        let now = match millis(SystemTime::now()) {
            Ok(now) => now,
            Err(_) => {
                lease.compromised = true;
                return;
            }
        };
        let mtime = if lease.seconds {
            now.div_ceil(1000) * 1000
        } else {
            now
        };
        if let Err(error) = touch(path, mtime) {
            if error.kind() == io::ErrorKind::NotFound || expired(lease.last_update) {
                lease.compromised = true;
                return;
            }
            delay = Duration::from_secs(1);
            continue;
        }
        lease.mtime = mtime;
        lease.last_update = SystemTime::now();
        delay = UPDATE;
    }
}

fn expired(time: SystemTime) -> bool {
    time.checked_add(STALE)
        .is_none_or(|deadline| deadline < SystemTime::now())
}

fn millis(time: SystemTime) -> rpc::Result<u128> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|_| conflict())
}

fn modified(path: &Path) -> io::Result<u128> {
    let metadata = fs::symlink_metadata(path)?;
    if super::files::redirects(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid native lock directory",
        ));
    }
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis())
}

fn touch(path: &Path, millis: u128) -> io::Result<()> {
    let time = UNIX_EPOCH
        + Duration::from_millis(millis.try_into().map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "Invalid native lock timestamp")
        })?);
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_WRITE_ATTRIBUTES,
        };
        OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?
    };
    #[cfg(not(windows))]
    let file = fs::File::open(path)?;
    file.set_times(FileTimes::new().set_accessed(time).set_modified(time))
}

fn conflict() -> rpc::Error {
    rpc::Error::conflict(
        "task_lock_conflict",
        "The native task list lock is held or its lease was compromised; retry the request",
    )
}
