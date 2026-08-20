use std::{
    ffi::OsString,
    fs,
    io::{self, Read as _, Write as _},
    mem::size_of,
    path::Path,
    ptr::{null, null_mut},
    time::Duration,
};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use windows_sys::Win32::{Foundation as F, Security::SECURITY_ATTRIBUTES, System::Threading as T};

use super::test_support::{
    DIRECTORY_ENV, ObservationHandle, ROLE_ENV, TestDirectory, helper_command, helper_directory,
    wait_for_path, wait_for_pid,
};
use crate::process::{
    FixedLaunch, LaunchSpec, ProcessObservation, ProcessStdio, StdioMode, StdioSpec,
    resource::{
        ActivationOutcome, BeginCompletion, ResourceEpoch, ResourceEvent, ResourceRuntime,
        ResourceShutdown,
    },
};

const STDIO_ORACLE_TEST: &str =
    "process::system::windows::stdio_tests::platform_writer_exposes_exact_directed_stdio";
const DROP_DESCENDANT_TEST: &str =
    "process::system::windows::stdio_tests::dropping_resource_runtime_contains_stdio_descendant";
const INPUT: &[u8] = b"stdin\0preserves\r\nexact bytes";
const STDOUT: &[u8] = b"stdout-only\0bytes";
const STDERR: &[u8] = b"stderr-only\r\nbytes";
const STDOUT_FRAME_START: &[u8] = b"\0matcha-stdio-stdout:start\0";
const STDOUT_FRAME_END: &[u8] = b"\0matcha-stdio-stdout:end\0";
const STDERR_FRAME_START: &[u8] = b"\0matcha-stdio-stderr:start\0";
const STDERR_FRAME_END: &[u8] = b"\0matcha-stdio-stderr:end\0";
const LARGE_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const IO_DEADLINE: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn platform_writer_exposes_exact_directed_stdio() {
    match helper_role().as_deref() {
        Some("stdio-child") => run_stdio_child(),
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-directed-stdio");
    let sentinel = InheritableSentinel::new().unwrap();
    let launch = stdio_launch_spec(
        STDIO_ORACLE_TEST,
        "stdio-child",
        directory.path(),
        sentinel.raw(),
    );
    let (runtime, _, stdio) = install_runtime(launch).await;
    let (stdin, stdout, stderr) = stdio.into_parts();
    let mut stdin = stdin.expect("piped stdin must be returned");
    let mut stdout = stdout.expect("piped stdout must be returned");
    let mut stderr = stderr.expect("piped stderr must be returned");

    let write = tokio::spawn(async move {
        stdin.write_all(INPUT).await.unwrap();
        stdin.shutdown().await.unwrap();
    });
    let read_stdout = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.unwrap();
        bytes
    });
    let read_stderr = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.unwrap();
        bytes
    });

    tokio::time::timeout(IO_DEADLINE, write)
        .await
        .expect("stdin write blocked the executor")
        .unwrap();
    let stdout = tokio::time::timeout(IO_DEADLINE, read_stdout)
        .await
        .expect("stdout did not drain")
        .unwrap();
    let stderr = tokio::time::timeout(IO_DEADLINE, read_stderr)
        .await
        .expect("stderr did not drain")
        .unwrap();

    let mut expected_stdout = Vec::with_capacity(STDOUT.len() + LARGE_PAYLOAD_BYTES);
    expected_stdout.extend_from_slice(STDOUT);
    expected_stdout.extend_from_slice(&large_payload());
    assert_eq!(
        framed_payload(&stdout, STDOUT_FRAME_START, STDOUT_FRAME_END),
        expected_stdout
    );
    assert_eq!(
        framed_payload(&stderr, STDERR_FRAME_START, STDERR_FRAME_END),
        STDERR
    );
    assert_eq!(count_occurrences(&stderr, STDOUT_FRAME_START), 0);
    assert_eq!(count_occurrences(&stdout, STDERR_FRAME_START), 0);
    assert!(
        !sentinel.is_signaled().unwrap(),
        "unrelated inheritable sentinel reached the child"
    );
    let drained = tokio::time::timeout(
        IO_DEADLINE,
        runtime
            .runtime
            .client
            .wait_drained(runtime.epoch, tokio::time::Instant::now() + IO_DEADLINE),
    )
    .await
    .expect("stdio child did not drain")
    .unwrap();
    let shutdown = tokio::time::timeout(
        IO_DEADLINE,
        runtime.runtime.client.shutdown(Some(runtime.epoch)),
    )
    .await
    .expect("resource shutdown did not complete")
    .unwrap();
    assert!(matches!(
        shutdown,
        ResourceShutdown::Terminated(exit) if exit == drained
    ));
    tokio::time::timeout(IO_DEADLINE, runtime.runtime.task)
        .await
        .expect("resource owner did not stop after shutdown")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_resource_runtime_contains_stdio_descendant() {
    match helper_role().as_deref() {
        Some("drop-root") => {
            run_drop_root();
            return;
        }
        Some("drop-member") => {
            run_drop_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-stdio-drop-descendant");
    let launch = stdio_launch_spec(
        DROP_DESCENDANT_TEST,
        "drop-root",
        directory.path(),
        F::INVALID_HANDLE_VALUE,
    );
    let (runtime, _, stdio) = install_runtime(launch).await;
    let (stdin, stdout, stderr) = stdio.into_parts();

    wait_for_path(&directory.root_ready());
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    drop(stdin);
    drop(stdout);
    drop(stderr);
    drop(runtime);
    member.wait_signaled().unwrap();
}

struct InstalledRuntime {
    runtime: ResourceRuntime,
    epoch: ResourceEpoch,
}

async fn install_runtime(
    launch: LaunchSpec,
) -> (InstalledRuntime, ProcessObservation, ProcessStdio) {
    let mut runtime = super::resource(FixedLaunch::new(launch));
    runtime.task.start();
    runtime.client.begin().await.unwrap();
    let epoch = match receive_event(&mut runtime).await {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    let managed = match receive_event(&mut runtime).await {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(managed),
            ..
        } => managed,
        _ => panic!("expected stdio resource installation"),
    };
    let observation = managed.observation;
    assert_eq!(
        managed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );
    (
        InstalledRuntime { runtime, epoch },
        observation,
        managed.stdio,
    )
}

async fn receive_event(runtime: &mut ResourceRuntime) -> ResourceEvent {
    tokio::time::timeout(IO_DEADLINE, runtime.events.recv())
        .await
        .expect("resource event exceeded the stdio deadline")
        .expect("resource owner stopped before the expected event")
}

fn stdio_launch_spec(
    test_name: &str,
    role: &str,
    directory: &Path,
    sentinel: F::HANDLE,
) -> LaunchSpec {
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
            (
                OsString::from("MATCHA_WINDOWS_SENTINEL_HANDLE"),
                OsString::from((sentinel as usize).to_string()),
            ),
        ],
        StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap()
}

fn run_stdio_child() -> ! {
    let result = std::panic::catch_unwind(|| {
        assert_sentinel_not_inherited();
        read_stdin_and_write_outputs();
    });
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

fn read_stdin_and_write_outputs() {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).unwrap();
    assert_eq!(
        input, INPUT,
        "stdin must preserve exact bytes and shutdown must yield EOF"
    );

    let stdout = std::thread::spawn(|| {
        let mut output = io::stdout().lock();
        output.write_all(STDOUT_FRAME_START).unwrap();
        output.write_all(STDOUT).unwrap();
        output.write_all(&large_payload()).unwrap();
        output.write_all(STDOUT_FRAME_END).unwrap();
        output.flush().unwrap();
    });
    let stderr = std::thread::spawn(|| {
        let mut output = io::stderr().lock();
        output.write_all(STDERR_FRAME_START).unwrap();
        output.write_all(STDERR).unwrap();
        output.write_all(STDERR_FRAME_END).unwrap();
        output.flush().unwrap();
    });
    stdout.join().unwrap();
    stderr.join().unwrap();
}

fn run_drop_root() {
    let directory = helper_directory();
    let member = helper_command(DROP_DESCENDANT_TEST, "drop-member", &directory)
        .spawn()
        .unwrap();
    fs::write(directory.join("member.pid"), member.id().to_string()).unwrap();
    drop(member);
    wait_for_path(&directory.join("member.ready"));
    fs::write(directory.join("root.ready"), b"ready").unwrap();
    wait_forever();
}

fn run_drop_member() {
    let directory = helper_directory();
    fs::write(directory.join("member.ready"), b"ready").unwrap();
    wait_forever();
}

fn wait_forever() -> ! {
    loop {
        std::thread::park_timeout(Duration::from_secs(30));
    }
}

fn assert_sentinel_not_inherited() {
    let raw = std::env::var("MATCHA_WINDOWS_SENTINEL_HANDLE")
        .unwrap()
        .parse::<usize>()
        .unwrap() as F::HANDLE;
    // SAFETY: SetEvent accepts an arbitrary candidate handle and reports failure for a missing event.
    assert_eq!(unsafe { T::SetEvent(raw) }, 0);
}

fn framed_payload<'a>(stream: &'a [u8], start: &[u8], end: &[u8]) -> &'a [u8] {
    assert_eq!(
        count_occurrences(stream, start),
        1,
        "target frame start must occur exactly once"
    );
    assert_eq!(
        count_occurrences(stream, end),
        1,
        "target frame end must occur exactly once"
    );
    let payload_start = stream
        .windows(start.len())
        .position(|window| window == start)
        .unwrap()
        + start.len();
    let payload_end = stream[payload_start..]
        .windows(end.len())
        .position(|window| window == end)
        .unwrap()
        + payload_start;
    &stream[payload_start..payload_end]
}

fn count_occurrences(stream: &[u8], marker: &[u8]) -> usize {
    stream
        .windows(marker.len())
        .filter(|window| *window == marker)
        .count()
}

fn large_payload() -> Vec<u8> {
    (0..LARGE_PAYLOAD_BYTES)
        .map(|index| b'a' + (index % 23) as u8)
        .collect()
}

struct InheritableSentinel(F::HANDLE);

impl InheritableSentinel {
    fn new() -> io::Result<Self> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        // SAFETY: attributes is valid for the call and the unnamed event needs no name buffer.
        let handle = unsafe { T::CreateEventW(&attributes, 1, 0, null()) };
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> F::HANDLE {
        self.0
    }

    fn is_signaled(&self) -> io::Result<bool> {
        // SAFETY: self owns a valid waitable event handle.
        match unsafe { T::WaitForSingleObject(self.0, 0) } {
            F::WAIT_OBJECT_0 => Ok(true),
            F::WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

impl Drop for InheritableSentinel {
    fn drop(&mut self) {
        // SAFETY: the sentinel owns one valid event handle and closes it once.
        unsafe { F::CloseHandle(self.0) };
    }
}

fn helper_role() -> Option<String> {
    std::env::var_os(ROLE_ENV).map(|role| role.to_string_lossy().into_owned())
}
