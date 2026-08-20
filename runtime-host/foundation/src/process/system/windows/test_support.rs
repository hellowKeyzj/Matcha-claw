use std::{
    ffi::{OsString, c_void},
    fs, io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    ptr::null_mut,
    thread,
    time::{Duration, Instant},
};

use windows_sys::Win32::{Foundation as F, System::JobObjects as J, System::Threading as T};

use super::super::super::{LaunchSpec, StdioMode, StdioSpec};

const DIRECTORY_RANDOM_BYTES: usize = 16;
const HELPER_DEADLINE: Duration = Duration::from_secs(30);
const RENDEZVOUS_DEADLINE: Duration = Duration::from_secs(10);
const RENDEZVOUS_POLL: Duration = Duration::from_millis(10);
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 2;

pub(super) const ROLE_ENV: &str = "MATCHA_WINDOWS_AUTHORITY_TEST_ROLE";
pub(super) const DIRECTORY_ENV: &str = "MATCHA_WINDOWS_AUTHORITY_TEST_DIRECTORY";

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut c_void,
        buffer: *mut u8,
        buffer_bytes: u32,
        flags: u32,
    ) -> i32;
}

pub(super) struct TestDirectory(PathBuf);

impl TestDirectory {
    pub(super) fn new(name: &str) -> Self {
        let mut random = [0_u8; DIRECTORY_RANDOM_BYTES];
        // SAFETY: the system-preferred provider accepts a null algorithm and random is writable.
        let status = unsafe {
            BCryptGenRandom(
                null_mut(),
                random.as_mut_ptr(),
                random.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        assert!(status >= 0, "test random generation failed");
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("matcha-{name}-{suffix}"));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }

    pub(super) fn entry_marker(&self) -> PathBuf {
        self.0.join("entry.marker")
    }

    pub(super) fn member_pid(&self) -> PathBuf {
        self.0.join("member.pid")
    }

    pub(super) fn member_ready(&self) -> PathBuf {
        self.0.join("member.ready")
    }

    pub(super) fn root_ready(&self) -> PathBuf {
        self.0.join("root.ready")
    }

    pub(super) fn scope_release(&self) -> PathBuf {
        self.0.join("scope.release")
    }

    pub(super) fn control_ready(&self) -> PathBuf {
        self.0.join("control.ready")
    }

    pub(super) fn control_release(&self) -> PathBuf {
        self.0.join("control.release")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) struct ObservationHandle(F::HANDLE);

impl ObservationHandle {
    pub(super) fn open(pid: u32) -> io::Result<Self> {
        // SAFETY: pid came from a process created by this test; no handle inheritance is requested.
        let raw = unsafe {
            T::OpenProcess(
                T::PROCESS_QUERY_LIMITED_INFORMATION | T::PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(raw))
        }
    }

    pub(super) fn is_signaled(&self) -> io::Result<bool> {
        // SAFETY: self owns a valid waitable process handle.
        match unsafe { T::WaitForSingleObject(self.0, 0) } {
            F::WAIT_OBJECT_0 => Ok(true),
            F::WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(super) fn wait_signaled(&self) -> io::Result<()> {
        // SAFETY: self owns a valid waitable process handle and the wait is bounded.
        match unsafe { T::WaitForSingleObject(self.0, RENDEZVOUS_DEADLINE.as_millis() as u32) } {
            F::WAIT_OBJECT_0 => Ok(()),
            F::WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process did not signal before the smoke deadline",
            )),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

impl Drop for ObservationHandle {
    fn drop(&mut self) {
        // SAFETY: ObservationHandle owns one valid handle and closes it once.
        unsafe { F::CloseHandle(self.0) };
    }
}

pub(super) struct HelperProcess {
    child: Child,
}

impl HelperProcess {
    pub(super) fn spawn(test_name: &str, role: &str, directory: &Path) -> io::Result<Self> {
        Ok(Self {
            child: helper_command(test_name, role, directory).spawn()?,
        })
    }

    pub(super) fn id(&self) -> u32 {
        self.child.id()
    }

    pub(super) fn wait_success(mut self) -> io::Result<()> {
        let status = self.child.wait()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("test helper failed"))
        }
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) fn helper_launch_spec(test_name: &str, role: &str, directory: &Path) -> LaunchSpec {
    LaunchSpec::try_new(
        std::env::current_exe().unwrap(),
        directory.to_path_buf(),
        [
            OsString::from(test_name),
            OsString::from("--exact"),
            OsString::from("--test-threads=1"),
        ],
        [
            (OsString::from(ROLE_ENV), OsString::from(role)),
            (
                OsString::from(DIRECTORY_ENV),
                directory.as_os_str().to_owned(),
            ),
        ],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap()
}

pub(super) fn helper_command(test_name: &str, role: &str, directory: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([test_name, "--exact", "--test-threads=1"])
        .env(ROLE_ENV, role)
        .env(DIRECTORY_ENV, directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

pub(super) fn helper_directory() -> PathBuf {
    PathBuf::from(
        std::env::var_os(DIRECTORY_ENV).expect("helper directory environment is required"),
    )
}

pub(super) fn wait_for_path(path: &Path) {
    let deadline = Instant::now() + RENDEZVOUS_DEADLINE;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "test marker was not created before the smoke deadline"
        );
        thread::sleep(RENDEZVOUS_POLL);
    }
}

pub(super) fn wait_for_release(path: &Path) {
    let deadline = Instant::now() + HELPER_DEADLINE;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "test marker was not released before the helper deadline"
        );
        thread::sleep(RENDEZVOUS_POLL);
    }
}

pub(super) fn wait_for_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + RENDEZVOUS_DEADLINE;
    loop {
        if let Ok(contents) = fs::read_to_string(path)
            && let Ok(pid) = contents.parse()
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "test marker did not contain a PID before the smoke deadline"
        );
        thread::sleep(RENDEZVOUS_POLL);
    }
}

pub(super) fn query_job_limits(
    job: F::HANDLE,
) -> io::Result<J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION> {
    let mut limits = J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // SAFETY: job is the exact live Job handle and limits is a correctly sized writable output.
    let succeeded = unsafe {
        J::QueryInformationJobObject(
            job,
            J::JobObjectExtendedLimitInformation,
            (&mut limits as *mut J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            null_mut(),
        )
    };
    bool_result(succeeded, limits)
}

pub(super) fn handle_flags(handle: F::HANDLE) -> io::Result<u32> {
    let mut flags = 0;
    // SAFETY: handle is the exact live Job handle and flags is writable.
    let succeeded = unsafe { F::GetHandleInformation(handle, &mut flags) };
    bool_result(succeeded, flags)
}

pub(super) fn is_process_in_job(process: F::HANDLE, job: F::HANDLE) -> io::Result<bool> {
    let mut assigned = 0;
    // SAFETY: process and job are the exact live handles created by this test.
    let succeeded = unsafe { J::IsProcessInJob(process, job, &mut assigned) };
    bool_result(succeeded, assigned != 0)
}

fn bool_result<T>(succeeded: i32, value: T) -> io::Result<T> {
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(value)
    }
}
