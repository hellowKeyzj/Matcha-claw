use std::{fs, process, thread, time::Duration, time::Instant};

use windows_sys::Win32::{Foundation as F, System::JobObjects as J};

use super::{
    child::SuspendedChild,
    command::CreateProcessInput,
    custody, job,
    test_support::{
        DIRECTORY_ENV, HelperProcess, ObservationHandle, ROLE_ENV, TestDirectory, handle_flags,
        helper_command, helper_directory, helper_launch_spec, is_process_in_job, query_job_limits,
        wait_for_path, wait_for_pid, wait_for_release,
    },
};

const ATOMIC_LAUNCH_TEST: &str =
    "process::system::windows::tests::atomic_launch_assigns_job_before_first_instruction";
const NATURAL_EXIT_TEST: &str =
    "process::system::windows::tests::natural_exit_waits_for_descendant_and_preserves_root_status";
const FORCED_CLEANUP_TEST: &str =
    "process::system::windows::tests::forced_cleanup_is_scope_local_and_confirms_members";
const ROOT_EXITED_CLEANUP_TEST: &str =
    "process::system::windows::tests::forced_cleanup_after_root_exit_remains_scope_local";
const ROOT_EXIT_CODE: i32 = 23;
const PROBE_DEADLINE: Duration = Duration::from_secs(10);
const PROBE_POLL: Duration = Duration::from_millis(10);

#[test]
fn private_job_has_closed_non_breakaway_authority() {
    let owned_job = job::create().unwrap();
    let limits = query_job_limits(owned_job.raw()).unwrap();
    let limit_flags = limits.BasicLimitInformation.LimitFlags;

    assert_ne!(limit_flags & J::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0);
    assert_eq!(limit_flags & J::JOB_OBJECT_LIMIT_BREAKAWAY_OK, 0);
    assert_eq!(limit_flags & J::JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, 0);
    assert_eq!(
        handle_flags(owned_job.raw()).unwrap() & F::HANDLE_FLAG_INHERIT,
        0
    );
}

#[test]
fn atomic_launch_assigns_job_before_first_instruction() {
    if helper_role().as_deref() == Some("entry-marker") {
        fs::write(helper_directory().join("entry.marker"), b"entered").unwrap();
        return;
    }
    assert_no_helper_role();

    let directory = TestDirectory::new("windows-atomic-launch");
    let owned_job = job::create().unwrap();
    let spec = helper_launch_spec(ATOMIC_LAUNCH_TEST, "entry-marker", directory.path());
    let mut input = CreateProcessInput::from_spec(&spec).unwrap();
    let stdio = super::stdio::ChildStdio::create(spec.stdio()).unwrap();
    let child = SuspendedChild::spawn(&mut input, &owned_job, &stdio, None, None).unwrap();

    assert!(!directory.entry_marker().exists());
    assert!(is_process_in_job(child.process().raw(), owned_job.raw()).unwrap());
    let identity = child.identity().unwrap();
    assert_ne!(identity.pid(), 0);
    assert_ne!(identity.creation_marker(), 0);

    child.resume().unwrap();
    wait_for_path(&directory.entry_marker());
    job::terminate(&owned_job, child.process(), identity).unwrap();
}

#[test]
fn natural_exit_waits_for_descendant_and_preserves_root_status() {
    match helper_role().as_deref() {
        Some("natural-root") => run_natural_root(),
        Some("natural-member") => run_scope_member(),
        Some(_) => panic!("unexpected helper role"),
        None => run_natural_exit_parent(),
    }
}

#[test]
fn forced_cleanup_is_scope_local_and_confirms_members() {
    match helper_role().as_deref() {
        Some("forced-root") => run_forced_root(),
        Some("forced-member") => run_scope_member(),
        Some("control") => run_control(),
        Some(_) => panic!("unexpected helper role"),
        None => run_forced_cleanup_parent(),
    }
}

#[test]
fn forced_cleanup_after_root_exit_remains_scope_local() {
    match helper_role().as_deref() {
        Some("root-exited-root") => run_natural_root(),
        Some("natural-member") => run_scope_member(),
        Some("control") => run_control(),
        Some(_) => panic!("unexpected helper role"),
        None => run_root_exited_cleanup_parent(),
    }
}

fn run_natural_exit_parent() {
    let directory = TestDirectory::new("windows-natural-exit");
    let spec = helper_launch_spec(NATURAL_EXIT_TEST, "natural-root", directory.path());
    let mut authority = custody::launch(&spec).unwrap();
    let root = ObservationHandle::open(authority.root_identity().pid()).unwrap();

    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());
    root.wait_signaled().unwrap();
    assert!(!member.is_signaled().unwrap());

    let started = Instant::now();
    assert!(authority.probe_exit().unwrap().is_none());
    assert!(started.elapsed() < Duration::from_secs(1));

    fs::write(directory.scope_release(), b"release").unwrap();
    member.wait_signaled().unwrap();
    let observation = wait_for_confirmed_exit(&mut authority);
    assert_eq!(observation.exit_code(), Some(ROOT_EXIT_CODE));
    assert_eq!(observation.signal(), None);
}

fn run_forced_cleanup_parent() {
    let directory = TestDirectory::new("windows-forced-cleanup");
    let control = HelperProcess::spawn(FORCED_CLEANUP_TEST, "control", directory.path()).unwrap();
    let control_observation = ObservationHandle::open(control.id()).unwrap();
    let spec = helper_launch_spec(FORCED_CLEANUP_TEST, "forced-root", directory.path());
    let mut authority = custody::launch(&spec).unwrap();
    let root = ObservationHandle::open(authority.root_identity().pid()).unwrap();

    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());
    wait_for_path(&directory.control_ready());
    assert!(!root.is_signaled().unwrap());
    assert!(!member.is_signaled().unwrap());
    assert!(!control_observation.is_signaled().unwrap());

    let observation = authority.terminate().unwrap();
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
    assert!(!control_observation.is_signaled().unwrap());
    assert_eq!(observation.exit_code(), Some(1));
    assert_eq!(observation.signal(), None);

    fs::write(directory.control_release(), b"release").unwrap();
    control.wait_success().unwrap();
    control_observation.wait_signaled().unwrap();
}

fn run_root_exited_cleanup_parent() {
    let directory = TestDirectory::new("windows-root-exited-cleanup");
    let control =
        HelperProcess::spawn(ROOT_EXITED_CLEANUP_TEST, "control", directory.path()).unwrap();
    let control_observation = ObservationHandle::open(control.id()).unwrap();
    let spec = helper_launch_spec(
        ROOT_EXITED_CLEANUP_TEST,
        "root-exited-root",
        directory.path(),
    );
    let mut authority = custody::launch(&spec).unwrap();
    let root = ObservationHandle::open(authority.root_identity().pid()).unwrap();

    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());
    wait_for_path(&directory.control_ready());
    root.wait_signaled().unwrap();
    assert!(!member.is_signaled().unwrap());
    assert!(!control_observation.is_signaled().unwrap());

    let observation = authority.terminate().unwrap();
    member.wait_signaled().unwrap();
    assert!(!control_observation.is_signaled().unwrap());
    assert_eq!(observation.exit_code(), Some(ROOT_EXIT_CODE));
    assert_eq!(observation.signal(), None);

    fs::write(directory.control_release(), b"release").unwrap();
    control.wait_success().unwrap();
    control_observation.wait_signaled().unwrap();
}

fn run_natural_root() -> ! {
    let directory = helper_directory();
    let member = helper_command(NATURAL_EXIT_TEST, "natural-member", &directory)
        .spawn()
        .unwrap();
    fs::write(directory.join("member.pid"), member.id().to_string()).unwrap();
    drop(member);
    wait_for_path(&directory.join("member.ready"));
    fs::write(directory.join("root.ready"), b"ready").unwrap();
    process::exit(ROOT_EXIT_CODE)
}

fn run_forced_root() {
    let directory = helper_directory();
    let member = helper_command(FORCED_CLEANUP_TEST, "forced-member", &directory)
        .spawn()
        .unwrap();
    fs::write(directory.join("member.pid"), member.id().to_string()).unwrap();
    drop(member);
    wait_for_path(&directory.join("member.ready"));
    fs::write(directory.join("root.ready"), b"ready").unwrap();
    wait_for_release(&directory.join("scope.release"));
}

fn run_scope_member() {
    let directory = helper_directory();
    fs::write(directory.join("member.ready"), b"ready").unwrap();
    wait_for_release(&directory.join("scope.release"));
}

fn run_control() {
    let directory = helper_directory();
    fs::write(directory.join("control.ready"), b"ready").unwrap();
    wait_for_release(&directory.join("control.release"));
}

fn wait_for_confirmed_exit(
    authority: &mut custody::WindowsAuthorityScope,
) -> crate::process::ExitObservation {
    let deadline = Instant::now() + PROBE_DEADLINE;
    loop {
        if let Some(observation) = authority.probe_exit().unwrap() {
            return observation;
        }
        assert!(
            Instant::now() < deadline,
            "authority scope did not drain before the smoke deadline"
        );
        thread::sleep(PROBE_POLL);
    }
}

fn helper_role() -> Option<String> {
    std::env::var_os(ROLE_ENV).map(|role| role.to_string_lossy().into_owned())
}

fn assert_no_helper_role() {
    assert!(std::env::var_os(ROLE_ENV).is_none());
    assert!(std::env::var_os(DIRECTORY_ENV).is_none());
}
