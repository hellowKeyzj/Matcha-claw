use std::ffi::{OsStr, OsString};
use std::fs;
use std::future::Future;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::{ChildStderr, Command, Stdio};
use std::task::Poll;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use super::super::super::{LaunchSpec, StdioMode, StdioSpec};
#[cfg(target_os = "linux")]
use super::custody::CONTROL_TIMEOUT;
use super::guardian_process::{GuardianProcess, finish as finish_guardian};
use super::guardian_protocol::encode_exit_status_payload;
use super::guardian_timeout::cleanup_timeout;
use super::host_protocol::decode_armed_payload;
use super::host_protocol::{decode_exit_status_payload, encode_launch_payload, encode_stdio_spec};
use super::io::{pipe_cloexec, read_frame, wait_ready, write_frame};
use super::protocol::{Frame, Message};
use super::scope::reap_sentinel_until;
use super::stdio::HostStdio;
use super::{CustodyFailure, NativeCustody, guardian, platform, sentinel, sentinel_test_support};

#[test]
fn sentinel_reap_rejects_non_child_identity() {
    let error = reap_sentinel_until(unsafe { libc::getpid() }, Instant::now()).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::ECHILD));
}

#[test]
fn cleanup_retry_retains_guardian_lease_until_the_same_session_confirms() {
    let directory = CleanupDirectory::new();
    let protected = directory.path().join("protected");
    fs::create_dir(&protected).unwrap();
    let mut host =
        GuardianHost::spawn_with_cleanup(directory.descriptor(), vec!["protected".into()]);

    let launch = encode_launch_payload(OsStr::new("relative"), Path::new("/"), &[], &[]).unwrap();
    let first = host.exchange(Message::Launch, launch).unwrap();
    assert_eq!(first.message, Message::CleanupUnconfirmed);
    assert!(first.payload.is_empty());
    assert!(directory.lease_is_held());

    fs::remove_dir(&protected).unwrap();
    let confirmed = host.exchange(Message::Terminate, Vec::new()).unwrap();
    assert_eq!(confirmed.message, Message::Terminate);
    assert!(confirmed.payload.is_empty());
    assert_guardian_exited_cleanly(&mut host);
    assert!(!protected.exists());
}

fn guardian_replying_with(responses: impl IntoIterator<Item = Frame>) -> GuardianProcess {
    let bytes = responses
        .into_iter()
        .flat_map(|response| response.encode())
        .map(|byte| format!("\\{byte:03o}"))
        .collect::<String>();
    let script = format!("printf '%b' '{bytes}'; sleep 1");
    let mut child = Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    GuardianProcess {
        stdin: child.stdin.take().unwrap(),
        stdout: child.stdout.take().unwrap(),
        child,
    }
}

fn guardian_waiting_to_reply(response: Frame) -> (GuardianProcess, ChildStderr) {
    let bytes = response
        .encode()
        .into_iter()
        .map(|byte| format!("\\{byte:03o}"))
        .collect::<String>();
    let script = format!(
        "released=; trap 'released=x' USR1; dd bs=34 count=1 of=/dev/null 2>/dev/null; printf x >&2; while [ -z \"$released\" ]; do :; done; printf '%b' '{bytes}'; extra=$(dd bs=1 count=1 2>/dev/null | wc -c); [ \"$extra\" -eq 0 ]"
    );
    let mut child = Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request_seen = child.stderr.take().unwrap();
    (
        GuardianProcess {
            stdin: child.stdin.take().unwrap(),
            stdout: child.stdout.take().unwrap(),
            child,
        },
        request_seen,
    )
}

#[test]
fn guardian_setup_failure_relinquishes_the_spawned_child() {
    if !run_in_isolated_process(
        "process::system::posix::tests::guardian_setup_failure_relinquishes_the_spawned_child",
    ) {
        return;
    }

    let mut child = Command::new("/bin/sleep")
        .arg("1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let child_pid = child.id() as libc::pid_t;
    drop(child.stdin.take());

    assert!(finish_guardian(child).is_err());
    assert_process_is_not_reaped(child_pid);
}

#[test]
fn custody_drop_relinquishes_guardian_without_reaping() {
    if !run_in_isolated_process(
        "process::system::posix::tests::custody_drop_relinquishes_guardian_without_reaping",
    ) {
        return;
    }

    let guardian = guardian_replying_with([]);
    let guardian_pid = guardian.child.id() as libc::pid_t;
    let custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };

    drop(custody);

    assert_process_is_not_reaped(guardian_pid);
}

#[tokio::test]
async fn dropped_exchange_future_resumes_the_same_request_before_reaping_guardian() {
    let (guardian, mut request_seen) =
        guardian_waiting_to_reply(Frame::new(Message::Terminate, [7; 16], 1, Vec::new()).unwrap());
    let guardian_pid = guardian.child.id() as libc::pid_t;
    let mut custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };

    let mut terminate = Box::pin(custody.terminate());
    let pending =
        std::future::poll_fn(|context| Poll::Ready(terminate.as_mut().poll(context).is_pending()))
            .await;
    assert!(pending);
    let marker = tokio::task::spawn_blocking(move || {
        let mut marker = [0_u8; 1];
        request_seen.read_exact(&mut marker).unwrap();
        marker
    })
    .await
    .unwrap();
    assert_eq!(marker, [b'x']);
    drop(terminate);

    let mut resumed = Box::pin(custody.terminate());
    let pending =
        std::future::poll_fn(|context| Poll::Ready(resumed.as_mut().poll(context).is_pending()))
            .await;
    assert!(pending);
    assert_eq!(unsafe { libc::kill(guardian_pid, libc::SIGUSR1) }, 0);
    assert!(resumed.await.is_ok());
    assert!(custody.in_flight.is_none());
    assert_eq!(custody.next_request_id, 2);
    assert_process_reaped(guardian_pid);
}

#[test]
fn unarmed_target_cleanup_kills_and_reaps_a_stuck_child() {
    let child_pid = unsafe { libc::fork() };
    assert_ne!(child_pid, -1);
    if child_pid == 0 {
        unsafe {
            libc::raise(libc::SIGSTOP);
            libc::_exit(0);
        }
    }
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(child_pid, &mut status, libc::WUNTRACED) },
        child_pid
    );
    assert!(libc::WIFSTOPPED(status));

    sentinel_test_support::reap_unarmed_target(child_pid).unwrap();
    assert_process_reaped(child_pid);
}

#[tokio::test]
async fn launch_failed_closes_liveness_after_valid_correlation() {
    let guardian =
        guardian_replying_with(
            [Frame::new(Message::LaunchFailed, [7; 16], 1, Vec::new()).unwrap()],
        );
    let guardian_pid = guardian.child.id() as libc::pid_t;
    let mut custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };
    let spec = LaunchSpec::try_new(
        std::path::PathBuf::from("/bin/true"),
        std::path::PathBuf::from("/"),
        [],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap();
    let host_stdio = HostStdio::create(spec.stdio()).unwrap();
    assert!(matches!(
        custody.launch(&spec, host_stdio).await,
        Err(CustodyFailure::LaunchFailed)
    ));
    assert_process_reaped(guardian_pid);
}

#[tokio::test]
async fn launch_protocol_uncertainty_relinquishes_guardian_without_reaping() {
    if !run_in_isolated_process(
        "process::system::posix::tests::launch_protocol_uncertainty_relinquishes_guardian_without_reaping",
    ) {
        return;
    }

    for response in [
        Frame::new(Message::LaunchFailed, [8; 16], 1, Vec::new()).unwrap(),
        Frame::new(Message::LaunchFailed, [7; 16], 2, Vec::new()).unwrap(),
    ] {
        let guardian = guardian_replying_with([response]);
        let guardian_pid = guardian.child.id() as libc::pid_t;
        let mut custody = NativeCustody {
            guardian: Some(guardian),
            nonce: [7; 16],
            next_request_id: 1,
            in_flight: None,
        };
        let spec = LaunchSpec::try_new(
            std::path::PathBuf::from("/bin/true"),
            std::path::PathBuf::from("/"),
            [],
            [],
            StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
        )
        .unwrap();
        let host_stdio = HostStdio::create(spec.stdio()).unwrap();
        assert!(matches!(
            custody.launch(&spec, host_stdio).await,
            Err(CustodyFailure::AuthorityLost)
        ));
        assert_process_is_not_reaped(guardian_pid);
    }
}

#[tokio::test]
async fn drain_protocol_uncertainty_relinquishes_guardian_without_reaping() {
    if !run_in_isolated_process(
        "process::system::posix::tests::drain_protocol_uncertainty_relinquishes_guardian_without_reaping",
    ) {
        return;
    }

    for response in [
        Frame::new(Message::Pending, [8; 16], 1, Vec::new()).unwrap(),
        Frame::new(Message::Pending, [7; 16], 2, Vec::new()).unwrap(),
    ] {
        let guardian = guardian_replying_with([response]);
        let guardian_pid = guardian.child.id() as libc::pid_t;
        let mut custody = NativeCustody {
            guardian: Some(guardian),
            nonce: [7; 16],
            next_request_id: 1,
            in_flight: None,
        };
        assert_eq!(
            custody.poll_drained().await,
            Err(CustodyFailure::AuthorityLost)
        );
        assert_process_is_not_reaped(guardian_pid);
        drop(custody);
    }
}

#[tokio::test]
async fn explicit_cleanup_returns_only_after_guardian_reap() {
    let guardian =
        guardian_replying_with([Frame::new(Message::Terminate, [7; 16], 1, Vec::new()).unwrap()]);
    let guardian_pid = guardian.child.id() as libc::pid_t;
    let mut custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };
    assert!(custody.terminate().await.is_ok());
    assert_process_reaped(guardian_pid);

    let guardian = guardian_replying_with([
        Frame::new(
            Message::Drained,
            [7; 16],
            1,
            encode_exit_status_payload(23 << 8),
        )
        .unwrap(),
        Frame::new(Message::Disarm, [7; 16], 2, Vec::new()).unwrap(),
    ]);
    let guardian_pid = guardian.child.id() as libc::pid_t;
    let mut custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };
    assert!(matches!(
        custody.poll_drained().await,
        Ok(super::CustodyDrain::Drained(_))
    ));
    assert_process_reaped(guardian_pid);
}

#[tokio::test]
async fn disarm_protocol_uncertainty_relinquishes_guardian_without_reaping() {
    if !run_in_isolated_process(
        "process::system::posix::tests::disarm_protocol_uncertainty_relinquishes_guardian_without_reaping",
    ) {
        return;
    }

    let guardian = guardian_replying_with([
        Frame::new(
            Message::Drained,
            [7; 16],
            1,
            encode_exit_status_payload(23 << 8),
        )
        .unwrap(),
        Frame::new(Message::AuthorityLost, [7; 16], 2, Vec::new()).unwrap(),
    ]);
    let guardian_pid = guardian.child.id() as libc::pid_t;
    let mut custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };

    assert_eq!(
        custody.poll_drained().await,
        Err(CustodyFailure::AuthorityLost)
    );
    assert_process_is_not_reaped(guardian_pid);
}

#[tokio::test]
async fn drain_timeout_relinquishes_guardian_without_reaping() {
    if !run_in_isolated_process(
        "process::system::posix::tests::drain_timeout_relinquishes_guardian_without_reaping",
    ) {
        return;
    }

    let mut child = Command::new("sh")
        .args(["-c", "sleep 1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let child_pid = child.id() as libc::pid_t;
    let guardian = GuardianProcess {
        stdin: child.stdin.take().unwrap(),
        stdout: child.stdout.take().unwrap(),
        child,
    };
    let mut custody = NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    };

    let started = Instant::now();
    assert_eq!(
        custody.poll_drained().await,
        Err(CustodyFailure::AuthorityLost)
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_process_is_not_reaped(child_pid);
}

fn assert_process_reaped(pid: libc::pid_t) {
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

fn assert_process_is_not_reaped(pid: libc::pid_t) {
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) }, 0);
}

#[cfg(target_os = "linux")]
fn wait_for_process_exit(pid: libc::pid_t) {
    let deadline = Instant::now() + CONTROL_TIMEOUT;
    loop {
        if unsafe { libc::kill(pid, 0) } == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return;
        }
        assert!(Instant::now() < deadline, "guardian cleanup did not finish");
        thread::sleep(Duration::from_millis(10));
    }
}

const NONCE: [u8; 16] = [9; 16];
const ROOT_EXIT_CODE: i32 = 23;
const ROOT_EXIT_DELAY: Duration = Duration::from_millis(1200);

struct CleanupDirectory {
    path: std::path::PathBuf,
}

impl CleanupDirectory {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("matcha-guardian-lease-{unique}"));
        fs::create_dir(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn descriptor(&self) -> OwnedFd {
        open_directory(&self.path)
    }

    fn lease_is_held(&self) -> bool {
        let directory = self.descriptor();
        let result = unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        result == -1 && io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock
    }
}

impl Drop for CleanupDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn open_directory(path: &Path) -> OwnedFd {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    assert_ne!(descriptor, -1);
    unsafe { OwnedFd::from_raw_fd(descriptor) }
}

struct GuardianHost {
    guardian_pid: Option<libc::pid_t>,
    input: Option<OwnedFd>,
    output: Option<OwnedFd>,
    next_request_id: u64,
}

impl GuardianHost {
    fn spawn() -> Self {
        Self::spawn_with_custody(None, Vec::new())
    }

    fn spawn_with_cleanup(cleanup_directory: OwnedFd, cleanup_names: Vec<OsString>) -> Self {
        Self::spawn_with_custody(Some(cleanup_directory), cleanup_names)
    }

    fn spawn_with_custody(
        cleanup_directory: Option<OwnedFd>,
        cleanup_names: Vec<OsString>,
    ) -> Self {
        let spec = StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null);
        let (target_stdio, stdio) = HostStdio::create(spec).unwrap().into_target_ends();
        let (guardian_input, host_input) = pipe_cloexec().unwrap();
        let (host_output, guardian_output) = pipe_cloexec().unwrap();
        let guardian_pid = unsafe { libc::fork() };
        assert_ne!(guardian_pid, -1);
        if guardian_pid == 0 {
            drop(host_input);
            drop(host_output);
            let result = guardian::run(
                guardian_input,
                guardian_output,
                target_stdio,
                None,
                cleanup_directory,
                None,
                cleanup_names,
            );
            unsafe { libc::_exit(if result.is_ok() { 0 } else { 1 }) }
        }

        drop(target_stdio);
        drop(stdio);
        drop(cleanup_directory);
        drop(guardian_input);
        drop(guardian_output);
        let mut host = Self {
            guardian_pid: Some(guardian_pid),
            input: Some(host_input),
            output: Some(host_output),
            next_request_id: 1,
        };
        let ready = host
            .exchange(Message::Hello, encode_stdio_spec(spec))
            .unwrap();
        assert_eq!(ready.message, Message::Ready);
        host
    }

    fn launch_root_with_descendant(&mut self, descendant_lifetime: u64) -> libc::pid_t {
        let command = format!(
            "sleep {descendant_lifetime} & sleep {}; exit {ROOT_EXIT_CODE}",
            ROOT_EXIT_DELAY.as_secs_f64(),
        );
        let arguments = [OsString::from("-c"), OsString::from(command)];
        self.launch(OsStr::new("/bin/sh"), &arguments)
    }

    fn launch(&mut self, program: &OsStr, arguments: &[OsString]) -> libc::pid_t {
        self.launch_in(program, Path::new("/"), arguments)
    }

    fn launch_in(
        &mut self,
        program: &OsStr,
        working_directory: &Path,
        arguments: &[OsString],
    ) -> libc::pid_t {
        let payload = encode_launch_payload(program, working_directory, arguments, &[]).unwrap();
        let armed = self.exchange(Message::Launch, payload).unwrap();
        assert_eq!(armed.message, Message::Armed);
        decode_armed_payload(&armed.payload).unwrap().0
    }

    fn launch_with_environment(
        &mut self,
        program: &OsStr,
        arguments: &[OsString],
        environment: &[(OsString, OsString)],
    ) -> libc::pid_t {
        let payload =
            encode_launch_payload(program, Path::new("/"), arguments, environment).unwrap();
        let armed = self.exchange(Message::Launch, payload).unwrap();
        assert_eq!(armed.message, Message::Armed);
        decode_armed_payload(&armed.payload).unwrap().0
    }

    fn exchange(&mut self, message: Message, payload: Vec<u8>) -> io::Result<Frame> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let request = Frame::new(message, NONCE, request_id, payload)?;
        let deadline = Instant::now() + cleanup_timeout();
        write_frame(self.input.as_ref().unwrap().as_raw_fd(), &request, deadline)?;
        let response = read_frame(self.output.as_ref().unwrap().as_raw_fd(), deadline)?;
        if response.nonce != NONCE || response.request_id != request_id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "guardian response correlation failed",
            ));
        }
        Ok(response)
    }

    #[cfg(target_os = "linux")]
    fn close_control(&mut self) {
        drop(self.input.take());
        drop(self.output.take());
    }

    fn wait_for_exit(&mut self) -> i32 {
        let guardian_pid = self.guardian_pid.take().unwrap();
        let deadline = Instant::now() + cleanup_timeout();
        loop {
            let mut status = 0;
            let waited = unsafe { libc::waitpid(guardian_pid, &mut status, libc::WNOHANG) };
            if waited == guardian_pid {
                return status;
            }
            if waited == -1 {
                panic!("guardian wait failed");
            }
            assert!(
                Instant::now() < deadline,
                "guardian did not exit before custody deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for GuardianHost {
    fn drop(&mut self) {
        drop(self.input.take());
        drop(self.output.take());
        self.guardian_pid = None;
    }
}

fn assert_pending(host: &mut GuardianHost) {
    let response = host.exchange(Message::Drain, Vec::new()).unwrap();
    assert_eq!(response.message, Message::Pending);
    assert!(response.payload.is_empty());
}

fn assert_guardian_exited_cleanly(host: &mut GuardianHost) {
    let status = host.wait_for_exit();
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);
    #[cfg(target_os = "linux")]
    assert_no_adopted_children();
}

#[cfg(target_os = "linux")]
fn assert_no_adopted_children() {
    let deadline = Instant::now() + cleanup_timeout();
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if waited == -1 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            return;
        }
        if waited > 0 {
            panic!("guardian orphaned a sentinel");
        }
        assert!(
            Instant::now() < deadline,
            "guardian left an unreaped sentinel child"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn fail_process_group_signal(error: libc::c_int) {
    install_process_group_signal_filter(libc::SECCOMP_RET_ERRNO | error as u32);
}

#[cfg(target_os = "linux")]
fn kill_on_process_group_signal() {
    install_process_group_signal_filter(libc::SECCOMP_RET_KILL_PROCESS);
}

#[cfg(target_os = "linux")]
fn install_process_group_signal_filter(action: u32) {
    let filter = [
        libc::sock_filter {
            code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: std::mem::offset_of!(libc::seccomp_data, nr) as u32,
        },
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            jt: 0,
            jf: 3,
            k: libc::SYS_kill as u32,
        },
        libc::sock_filter {
            code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: std::mem::offset_of!(libc::seccomp_data, args) as u32,
        },
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K) as u16,
            jt: 0,
            jf: 1,
            k: 1 << 31,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: action,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_ALLOW,
        },
    ];
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr().cast_mut(),
    };
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
        0
    );
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) },
        0
    );
}

fn run_in_isolated_process(test_name: &str) -> bool {
    if std::env::var_os("MATCHA_POSIX_ISOLATED_TEST").is_some() {
        return true;
    }
    let succeeded = Command::new(std::env::current_exe().unwrap())
        .arg(test_name)
        .arg("--exact")
        .arg("--test-threads=1")
        .env("MATCHA_POSIX_ISOLATED_TEST", "1")
        .status()
        .unwrap()
        .success();
    assert!(succeeded, "isolated test helper failed");
    false
}

#[test]
fn authority_loss_exit_does_not_signal_its_process_group() {
    if !run_in_isolated_process(
        "process::system::posix::tests::authority_loss_exit_does_not_signal_its_process_group",
    ) {
        return;
    }

    let (response_read, response_write) = super::guardian_io::socket_pair_cloexec().unwrap();
    let (witness_read, witness_write) = pipe_cloexec().unwrap();
    let request = Frame::new(Message::Drain, NONCE, 1, Vec::new()).unwrap();
    let sentinel_pid = unsafe { libc::fork() };
    assert_ne!(sentinel_pid, -1);
    if sentinel_pid == 0 {
        drop(response_read);
        drop(witness_read);
        if unsafe { libc::setpgid(0, 0) } == -1 {
            unsafe { libc::_exit(1) }
        }
        let witness_pid = unsafe { libc::fork() };
        if witness_pid == -1 {
            unsafe { libc::_exit(1) }
        }
        if witness_pid == 0 {
            drop(response_write);
            thread::sleep(Duration::from_millis(200));
            let marker = [1_u8];
            unsafe {
                libc::write(
                    witness_write.as_raw_fd(),
                    marker.as_ptr().cast(),
                    marker.len(),
                );
                libc::_exit(0);
            }
        }
        drop(witness_write);
        sentinel::exit_authority_lost(response_write.as_raw_fd(), &request);
    }

    drop(response_write);
    drop(witness_write);
    let response = read_frame(
        response_read.as_raw_fd(),
        Instant::now() + cleanup_timeout(),
    )
    .unwrap();
    assert_eq!(response.message, Message::AuthorityLost);
    wait_ready(
        witness_read.as_raw_fd(),
        libc::POLLIN,
        Instant::now() + cleanup_timeout(),
    )
    .unwrap();
    let mut marker = [0_u8];
    assert_eq!(
        unsafe {
            libc::read(
                witness_read.as_raw_fd(),
                marker.as_mut_ptr().cast(),
                marker.len(),
            )
        },
        1
    );
    assert_eq!(marker, [1]);
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(sentinel_pid, &mut status, 0) },
        sentinel_pid
    );
    assert!(libc::WIFEXITED(status));
}

#[test]
fn launch_uses_absolute_program_and_exact_environment() {
    if !run_in_isolated_process(
        "process::system::posix::tests::launch_uses_absolute_program_and_exact_environment",
    ) {
        return;
    }

    unsafe { std::env::set_var("MATCHA_HOST_ONLY_VALUE", "host-only") };

    let mut empty_environment = GuardianHost::spawn();
    empty_environment.launch(
        OsStr::new("/bin/sh"),
        &[
            OsString::from("-c"),
            OsString::from("test -z \"${MATCHA_HOST_ONLY_VALUE+x}\""),
        ],
    );
    let drained = drain_until_terminal(&mut empty_environment);
    assert_eq!(
        decode_exit_status_payload(&drained.payload).unwrap(),
        (Some(0), None)
    );
    assert_eq!(
        empty_environment
            .exchange(Message::Disarm, Vec::new())
            .unwrap()
            .message,
        Message::Disarm
    );
    assert!(libc::WIFEXITED(empty_environment.wait_for_exit()));

    let mut exact_environment = GuardianHost::spawn();
    exact_environment.launch_with_environment(
        OsStr::new("/bin/sh"),
        &[
            OsString::from("-c"),
            OsString::from(
                "test \"$MATCHA_PUBLIC_VALUE\" = visible && test -z \"${MATCHA_HOST_ONLY_VALUE+x}\"",
            ),
        ],
        &[(
            OsString::from("MATCHA_PUBLIC_VALUE"),
            OsString::from("visible"),
        )],
    );
    let drained = drain_until_terminal(&mut exact_environment);
    assert_eq!(
        decode_exit_status_payload(&drained.payload).unwrap(),
        (Some(0), None)
    );
    assert_eq!(
        exact_environment
            .exchange(Message::Disarm, Vec::new())
            .unwrap()
            .message,
        Message::Disarm
    );
    assert!(libc::WIFEXITED(exact_environment.wait_for_exit()));

    let mut relative = GuardianHost::spawn();
    let payload = encode_launch_payload(OsStr::new("sh"), Path::new("/"), &[], &[]).unwrap();
    let rejected = relative.exchange(Message::Launch, payload).unwrap();
    assert_eq!(rejected.message, Message::LaunchFailed);
    assert!(rejected.payload.is_empty());
    assert!(libc::WIFEXITED(relative.wait_for_exit()));
}

fn drain_until_terminal(host: &mut GuardianHost) -> Frame {
    let deadline = Instant::now() + cleanup_timeout();
    loop {
        let response = host.exchange(Message::Drain, Vec::new()).unwrap();
        if response.message == Message::Drained {
            return response;
        }
        assert_eq!(response.message, Message::Pending);
        assert!(Instant::now() < deadline, "target scope did not drain");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn setup_and_exec_failures_report_launch_failed_after_full_reap() {
    if !run_in_isolated_process(
        "process::system::posix::tests::setup_and_exec_failures_report_launch_failed_after_full_reap",
    ) {
        return;
    }

    for (program, working_directory) in [
        (
            OsStr::new("/bin/true"),
            Path::new("/definitely/not/a/matcha-working-directory"),
        ),
        (
            OsStr::new("/definitely/not/a/matcha-executable"),
            Path::new("/"),
        ),
        (Path::new("/").as_os_str(), Path::new("/")),
    ] {
        let mut host = GuardianHost::spawn();
        let payload = encode_launch_payload(program, working_directory, &[], &[]).unwrap();
        let response = host.exchange(Message::Launch, payload).unwrap();
        assert_eq!(response.message, Message::LaunchFailed);
        assert!(response.payload.is_empty());
        assert_guardian_exited_cleanly(&mut host);
    }
}

#[test]
fn stalled_pre_exec_cleanup_reports_launch_failed_after_full_reap() {
    if !run_in_isolated_process(
        "process::system::posix::tests::stalled_pre_exec_cleanup_reports_launch_failed_after_full_reap",
    ) {
        return;
    }

    sentinel_test_support::set_stall_before_target_setup(true);
    let mut host = GuardianHost::spawn();
    let payload = encode_launch_payload(OsStr::new("/bin/true"), Path::new("/"), &[], &[]).unwrap();
    let response = host.exchange(Message::Launch, payload).unwrap();
    sentinel_test_support::set_stall_before_target_setup(false);
    assert_eq!(response.message, Message::LaunchFailed);
    assert!(response.payload.is_empty());
    assert_guardian_exited_cleanly(&mut host);
}

#[test]
fn unresolved_pre_exec_cleanup_reports_authority_lost() {
    if !run_in_isolated_process(
        "process::system::posix::tests::unresolved_pre_exec_cleanup_reports_authority_lost",
    ) {
        return;
    }

    sentinel_test_support::set_stall_before_target_setup(true);
    sentinel_test_support::set_cleanup_confirmation_failure(true);
    let mut host = GuardianHost::spawn();
    let payload = encode_launch_payload(OsStr::new("/bin/true"), Path::new("/"), &[], &[]).unwrap();
    let response = host.exchange(Message::Launch, payload).unwrap();
    sentinel_test_support::set_cleanup_confirmation_failure(false);
    sentinel_test_support::set_stall_before_target_setup(false);
    assert_eq!(response.message, Message::AuthorityLost);
    assert!(response.payload.is_empty());
    assert_guardian_exited_cleanly(&mut host);
}

#[cfg(target_os = "linux")]
#[test]
fn terminate_reaps_a_zombie_only_scope_without_signaling_its_group() {
    if !run_in_isolated_process(
        "process::system::posix::tests::terminate_reaps_a_zombie_only_scope_without_signaling_its_group",
    ) {
        return;
    }

    fail_process_group_signal(libc::EPERM);
    let mut host = GuardianHost::spawn();
    let root_pid = host.launch(OsStr::new("/bin/true"), &[]);
    let deadline = Instant::now() + cleanup_timeout();
    loop {
        let stat = fs::read_to_string(format!("/proc/{root_pid}/stat")).unwrap();
        let closing_parenthesis = stat.rfind(')').unwrap();
        if stat[closing_parenthesis + 2..].starts_with("Z ") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "target root did not become a zombie"
        );
        thread::sleep(Duration::from_millis(10));
    }

    let terminated = host.exchange(Message::Terminate, Vec::new()).unwrap();
    assert_eq!(terminated.message, Message::Terminate);
    assert!(terminated.payload.is_empty());
    let status = host.wait_for_exit();
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);
}

#[cfg(target_os = "linux")]
#[test]
fn process_group_signal_esrch_requires_terminal_root_and_only_root_proof() {
    if !run_in_isolated_process(
        "process::system::posix::tests::process_group_signal_esrch_requires_terminal_root_and_only_root_proof",
    ) {
        return;
    }

    fail_process_group_signal(libc::ESRCH);
    let mut host = GuardianHost::spawn();
    let root_pid = host.launch(OsStr::new("/bin/sleep"), &[OsString::from("30")]);
    let response = host.exchange(Message::Terminate, Vec::new());
    assert!(!matches!(response, Ok(frame) if frame.message == Message::Terminate));
    assert_eq!(unsafe { libc::kill(root_pid, 0) }, 0);
    assert_eq!(unsafe { libc::kill(root_pid, libc::SIGKILL) }, 0);
    wait_for_process_exit(root_pid);
    host.wait_for_exit();
}

#[test]
fn natural_scope_drain_preserves_authority_and_root_status() {
    if !run_in_isolated_process(
        "process::system::posix::tests::natural_scope_drain_preserves_authority_and_root_status",
    ) {
        return;
    }

    let mut pending_host = GuardianHost::spawn();
    pending_host.launch_root_with_descendant(30);
    thread::sleep(ROOT_EXIT_DELAY + Duration::from_millis(100));

    assert_pending(&mut pending_host);
    assert_pending(&mut pending_host);

    let terminated = pending_host
        .exchange(Message::Terminate, Vec::new())
        .unwrap();
    assert_eq!(terminated.message, Message::Terminate);
    assert!(terminated.payload.is_empty());
    let status = pending_host.wait_for_exit();
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);

    let mut drained_host = GuardianHost::spawn();
    let drained_root_pid = drained_host.launch_root_with_descendant(2);
    thread::sleep(ROOT_EXIT_DELAY + Duration::from_millis(100));

    assert_pending(&mut drained_host);
    thread::sleep(Duration::from_secs(1));

    let drained = drained_host.exchange(Message::Drain, Vec::new()).unwrap();
    assert_eq!(drained.message, Message::Drained);
    assert_eq!(
        decode_exit_status_payload(&drained.payload).unwrap(),
        (Some(ROOT_EXIT_CODE), None)
    );
    assert!(platform::prove_process(drained_root_pid).is_err());

    let disarmed = drained_host.exchange(Message::Disarm, Vec::new()).unwrap();
    assert_eq!(disarmed.message, Message::Disarm);
    let status = drained_host.wait_for_exit();
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);

    let mut disarm_host = GuardianHost::spawn();
    disarm_host.launch_root_with_descendant(30);
    thread::sleep(ROOT_EXIT_DELAY + Duration::from_millis(100));

    assert_pending(&mut disarm_host);
    let rejected = disarm_host.exchange(Message::Disarm, Vec::new()).unwrap();
    assert_eq!(rejected.message, Message::AuthorityLost);
    assert!(rejected.payload.is_empty());
    let status = disarm_host.wait_for_exit();
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);
}

#[cfg(target_os = "linux")]
#[test]
fn guardian_reaps_sentinel_on_every_terminal_path() {
    if !run_in_isolated_process(
        "process::system::posix::tests::guardian_reaps_sentinel_on_every_terminal_path",
    ) {
        return;
    }

    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );

    let mut terminated = GuardianHost::spawn();
    terminated.launch(OsStr::new("/bin/sleep"), &[OsString::from("30")]);
    assert_eq!(
        terminated
            .exchange(Message::Terminate, Vec::new())
            .unwrap()
            .message,
        Message::Terminate
    );
    assert_guardian_exited_cleanly(&mut terminated);

    let mut disarmed = GuardianHost::spawn();
    disarmed.launch(OsStr::new("/bin/true"), &[]);
    let deadline = Instant::now() + cleanup_timeout();
    loop {
        let drained = disarmed.exchange(Message::Drain, Vec::new()).unwrap();
        if drained.message == Message::Drained {
            break;
        }
        assert_eq!(drained.message, Message::Pending);
        assert!(Instant::now() < deadline, "target scope did not drain");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        disarmed
            .exchange(Message::Disarm, Vec::new())
            .unwrap()
            .message,
        Message::Disarm
    );
    assert_guardian_exited_cleanly(&mut disarmed);

    let mut launch_failed = GuardianHost::spawn();
    let invalid_launch = encode_launch_payload(
        OsStr::new("/definitely/not/a/matcha-executable"),
        Path::new("/"),
        &[],
        &[],
    )
    .unwrap();
    assert_eq!(
        launch_failed
            .exchange(Message::Launch, invalid_launch)
            .unwrap()
            .message,
        Message::LaunchFailed
    );
    assert_guardian_exited_cleanly(&mut launch_failed);

    let mut protocol_failed = GuardianHost::spawn();
    assert_eq!(
        protocol_failed
            .exchange(Message::Drain, Vec::new())
            .unwrap()
            .message,
        Message::AuthorityLost
    );
    assert_guardian_exited_cleanly(&mut protocol_failed);

    let mut active_protocol_failed = GuardianHost::spawn();
    active_protocol_failed.launch(OsStr::new("/bin/sleep"), &[OsString::from("30")]);
    assert_eq!(
        active_protocol_failed
            .exchange(
                Message::Hello,
                encode_stdio_spec(StdioSpec::new(
                    StdioMode::Null,
                    StdioMode::Null,
                    StdioMode::Null,
                )),
            )
            .unwrap()
            .message,
        Message::AuthorityLost
    );
    assert_guardian_exited_cleanly(&mut active_protocol_failed);

    let mut unarmed_host_loss = GuardianHost::spawn();
    unarmed_host_loss.close_control();
    assert_guardian_exited_cleanly(&mut unarmed_host_loss);

    let mut active_host_loss = GuardianHost::spawn();
    active_host_loss.launch(OsStr::new("/bin/sleep"), &[OsString::from("30")]);
    active_host_loss.close_control();
    assert_guardian_exited_cleanly(&mut active_host_loss);
}

#[cfg(target_os = "linux")]
#[test]
fn drained_guardian_rejects_further_target_commands_without_signaling_the_old_group() {
    if !run_in_isolated_process(
        "process::system::posix::tests::drained_guardian_rejects_further_target_commands_without_signaling_the_old_group",
    ) {
        return;
    }

    for command in [Message::Drain, Message::Terminate] {
        let case_pid = unsafe { libc::fork() };
        assert_ne!(case_pid, -1);
        if case_pid == 0 {
            let result = std::panic::catch_unwind(|| assert_drained_command_rejected(command));
            unsafe { libc::_exit(if result.is_ok() { 0 } else { 1 }) }
        }

        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(case_pid, &mut status, 0) }, case_pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }
}

#[cfg(target_os = "linux")]
fn assert_drained_command_rejected(command: Message) {
    kill_on_process_group_signal();
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );
    let mut host = GuardianHost::spawn();
    host.launch(OsStr::new("/bin/true"), &[]);
    let drained = drain_until_terminal(&mut host);
    assert_eq!(
        decode_exit_status_payload(&drained.payload).unwrap(),
        (Some(0), None)
    );
    let rejected = host.exchange(command, Vec::new()).unwrap();
    assert_eq!(rejected.message, Message::AuthorityLost);
    assert!(rejected.payload.is_empty());
    let guardian_status = host.wait_for_exit();
    assert!(libc::WIFEXITED(guardian_status));
    assert_eq!(libc::WEXITSTATUS(guardian_status), 0);
    assert_no_adopted_children();
}

#[cfg(target_os = "linux")]
#[test]
fn reaped_sentinel_rejects_further_target_commands_without_signaling_the_old_group() {
    if !run_in_isolated_process(
        "process::system::posix::tests::reaped_sentinel_rejects_further_target_commands_without_signaling_the_old_group",
    ) {
        return;
    }

    for command in [Message::Drain, Message::Terminate] {
        let case_pid = unsafe { libc::fork() };
        assert_ne!(case_pid, -1);
        if case_pid == 0 {
            let result = std::panic::catch_unwind(|| assert_reaped_command_rejected(command));
            unsafe { libc::_exit(if result.is_ok() { 0 } else { 1 }) }
        }

        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(case_pid, &mut status, 0) }, case_pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }
}

#[cfg(target_os = "linux")]
fn assert_reaped_command_rejected(command: Message) {
    kill_on_process_group_signal();
    let (sentinel_liveness, guardian_liveness) = pipe_cloexec().unwrap();
    let (guardian_control, sentinel_control) = super::guardian_io::socket_pair_cloexec().unwrap();
    let (target_stdio, _stdio) = HostStdio::create(StdioSpec::new(
        StdioMode::Null,
        StdioMode::Null,
        StdioMode::Null,
    ))
    .unwrap()
    .into_target_ends();
    let sentinel_pid = sentinel::spawn(
        sentinel_liveness,
        sentinel_control,
        target_stdio,
        None,
        None,
    )
    .unwrap();
    let deadline = Instant::now() + cleanup_timeout();

    let launch = Frame::new(
        Message::Launch,
        NONCE,
        1,
        encode_launch_payload(OsStr::new("/bin/true"), Path::new("/"), &[], &[]).unwrap(),
    )
    .unwrap();
    write_frame(guardian_control.as_raw_fd(), &launch, deadline).unwrap();
    let armed = read_frame(guardian_control.as_raw_fd(), deadline).unwrap();
    assert_eq!(armed.message, Message::Armed);

    let mut request_id = 2;
    loop {
        let drain = Frame::new(Message::Drain, NONCE, request_id, Vec::new()).unwrap();
        write_frame(guardian_control.as_raw_fd(), &drain, deadline).unwrap();
        let response = read_frame(guardian_control.as_raw_fd(), deadline).unwrap();
        request_id += 1;
        if response.message == Message::Drained {
            break;
        }
        assert_eq!(response.message, Message::Pending);
        assert!(Instant::now() < deadline, "target scope did not drain");
    }

    let request = Frame::new(command, NONCE, request_id, Vec::new()).unwrap();
    write_frame(guardian_control.as_raw_fd(), &request, deadline).unwrap();
    let rejected = read_frame(guardian_control.as_raw_fd(), deadline).unwrap();
    drop(guardian_control);
    drop(guardian_liveness);
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(sentinel_pid, &mut status, 0) },
        sentinel_pid
    );

    assert_eq!(rejected.message, Message::AuthorityLost);
    assert_eq!(rejected.request_id, request_id);
    assert!(rejected.payload.is_empty());
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);
    assert_no_adopted_children();
}

#[test]
fn timed_out_sentinel_cleanup_reaps_exact_child_without_reporting_success() {
    let sentinel_pid = unsafe { libc::fork() };
    assert_ne!(sentinel_pid, -1);
    if sentinel_pid == 0 {
        loop {
            unsafe { libc::pause() };
        }
    }

    let error = reap_sentinel_until(sentinel_pid, Instant::now()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(sentinel_pid, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}
