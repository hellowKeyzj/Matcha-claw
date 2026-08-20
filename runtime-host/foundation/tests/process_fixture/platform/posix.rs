use std::{fmt, io, thread, time::Instant};

use crate::protocol::ProcessIdentity;

const WAIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

pub(crate) fn current_identity() -> Result<ProcessIdentity, PlatformError> {
    let pid = std::process::id();
    Ok(observe_process(pid)?
        .ok_or(PlatformError::IdentityUnavailable)?
        .identity)
}

pub(crate) fn parent_identity(subject: ProcessIdentity) -> Result<ProcessIdentity, PlatformError> {
    let subject_observation = observe_exact_live_process(subject)?;
    let parent_pid = subject_observation.parent_pid;
    native_pid(parent_pid)?;

    let parent_observation = observe_process(parent_pid)?
        .filter(|observation| observation.is_alive)
        .ok_or(PlatformError::IdentityUnavailable)?;
    let parent_identity = parent_observation.identity;
    observe_exact_live_process(parent_identity)?;
    if observe_exact_live_process(subject)?.parent_pid != parent_pid {
        return Err(PlatformError::IdentityUnavailable);
    }
    Ok(parent_identity)
}

pub(crate) fn is_exact_identity_alive(expected: ProcessIdentity) -> Result<bool, PlatformError> {
    Ok(observe_process(expected.pid())?
        .is_some_and(|observed| is_exact_live_process(observed, expected)))
}

pub(crate) fn hard_kill_exact(expected: ProcessIdentity) -> Result<(), PlatformError> {
    let pid = native_pid(expected.pid())?;
    if !matches!(
        observe_process(expected.pid())?,
        Some(observed) if observed.identity == expected && observed.is_alive
    ) {
        return Ok(());
    }

    if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
        return Ok(());
    }

    let error = io::Error::last_os_error();
    if is_process_missing(&error) {
        return Ok(());
    }
    Err(PlatformError::SignalFailed)
}

pub(crate) fn wait_for_exact_exit(
    expected: ProcessIdentity,
    deadline: Instant,
) -> Result<(), PlatformError> {
    loop {
        if !is_exact_identity_alive(expected)? {
            return Ok(());
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(PlatformError::ExitDeadlineElapsed);
        }
        thread::sleep(WAIT_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessObservation {
    identity: ProcessIdentity,
    parent_pid: u32,
    is_alive: bool,
}

fn observe_exact_live_process(
    expected: ProcessIdentity,
) -> Result<ProcessObservation, PlatformError> {
    observe_process(expected.pid())?
        .filter(|observed| is_exact_live_process(*observed, expected))
        .ok_or(PlatformError::IdentityUnavailable)
}

fn is_exact_live_process(observed: ProcessObservation, expected: ProcessIdentity) -> bool {
    observed.identity == expected && observed.is_alive
}

fn observe_process(pid: u32) -> Result<Option<ProcessObservation>, PlatformError> {
    let native_pid = native_pid(pid)?;
    let process = match observe_native_process(native_pid) {
        Ok(observation) => observation,
        Err(error) if is_process_missing(&error) => return Ok(None),
        Err(_) => return Err(PlatformError::IdentityObservationFailed),
    };
    Ok(Some(ProcessObservation {
        identity: ProcessIdentity::new(pid, process.creation_marker),
        parent_pid: process.parent_pid,
        is_alive: process.is_alive,
    }))
}

fn native_pid(pid: u32) -> Result<libc::pid_t, PlatformError> {
    let pid = libc::pid_t::try_from(pid).map_err(|_| PlatformError::InvalidProcessId)?;
    if pid <= 0 {
        return Err(PlatformError::InvalidProcessId);
    }
    Ok(pid)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NativeProcessObservation {
    creation_marker: u128,
    parent_pid: u32,
    is_alive: bool,
}

#[cfg(target_os = "linux")]
fn observe_native_process(pid: libc::pid_t) -> io::Result<NativeProcessObservation> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    parse_linux_process(&stat)
}

#[cfg(target_os = "linux")]
fn parse_linux_process(stat: &str) -> io::Result<NativeProcessObservation> {
    let closing_parenthesis = stat.rfind(')').ok_or_else(invalid_linux_stat)?;
    let mut fields = stat
        .get(closing_parenthesis + 1..)
        .ok_or_else(invalid_linux_stat)?
        .split_whitespace();
    let state = fields.next().ok_or_else(invalid_linux_stat)?;
    if !matches!(
        state,
        "R" | "S" | "D" | "Z" | "T" | "t" | "X" | "x" | "K" | "W" | "P" | "I"
    ) {
        return Err(invalid_linux_stat());
    }
    let parent_pid = fields
        .next()
        .ok_or_else(invalid_linux_stat)?
        .parse::<u32>()
        .map_err(|_| invalid_linux_stat())?;
    let start_time = fields
        .nth(17)
        .ok_or_else(invalid_linux_stat)?
        .parse::<u64>()
        .map_err(|_| invalid_linux_stat())?;
    Ok(NativeProcessObservation {
        creation_marker: u128::from(start_time),
        parent_pid,
        is_alive: state != "Z" && state != "X" && state != "x",
    })
}

#[cfg(target_os = "linux")]
fn invalid_linux_stat() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Linux process stat is invalid")
}

#[cfg(target_os = "macos")]
fn observe_native_process(pid: libc::pid_t) -> io::Result<NativeProcessObservation> {
    let info = macos_process_info(pid)?;
    Ok(NativeProcessObservation {
        creation_marker: macos_creation_marker(&info),
        parent_pid: info.pbi_ppid,
        is_alive: info.pbi_status != libc::SZOMB,
    })
}

#[cfg(target_os = "macos")]
fn macos_process_info(pid: libc::pid_t) -> io::Result<libc::proc_bsdinfo> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if written != expected {
        let error = io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(0) {
            io::Error::new(
                io::ErrorKind::NotFound,
                "macOS process identity is unavailable",
            )
        } else {
            error
        });
    }
    Ok(unsafe { info.assume_init() })
}

#[cfg(target_os = "macos")]
const fn macos_creation_marker(info: &libc::proc_bsdinfo) -> u128 {
    pack_macos_start_time(info.pbi_start_tvsec, info.pbi_start_tvusec)
}

#[cfg(target_os = "macos")]
const fn pack_macos_start_time(seconds: u64, microseconds: u64) -> u128 {
    ((seconds as u128) << 64) | microseconds as u128
}

fn is_process_missing(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH) || error.kind() == io::ErrorKind::NotFound
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlatformError {
    InvalidProcessId,
    IdentityUnavailable,
    IdentityObservationFailed,
    SignalFailed,
    ExitDeadlineElapsed,
}

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidProcessId => "fixture process id is invalid",
            Self::IdentityUnavailable => "fixture process identity is unavailable",
            Self::IdentityObservationFailed => "fixture process identity observation failed",
            Self::SignalFailed => "fixture process signal failed",
            Self::ExitDeadlineElapsed => "fixture process exit deadline elapsed",
        })
    }
}

impl std::error::Error for PlatformError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_parser_reads_parent_marker_and_liveness_with_complex_command_name() {
        let prefix = "57 (fixture ) worker) ";
        let fields = std::iter::once("S".to_owned())
            .chain((1_u64..=21).map(|value| value.to_string()))
            .collect::<Vec<_>>()
            .join(" ");
        let stat = format!("{prefix}{fields}");

        assert_eq!(
            parse_linux_process(&stat).unwrap(),
            NativeProcessObservation {
                creation_marker: 19,
                parent_pid: 1,
                is_alive: true,
            }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_parser_marks_terminal_states_dead() {
        for state in ["Z", "X", "x"] {
            let fields = std::iter::once(state.to_owned())
                .chain((1_u64..=21).map(|value| value.to_string()))
                .collect::<Vec<_>>()
                .join(" ");

            assert!(
                !parse_linux_process(&format!("57 (fixture) {fields}"))
                    .unwrap()
                    .is_alive
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_parser_rejects_invalid_state_parent_or_start_time() {
        assert!(parse_linux_process("57 fixture S 1 2 3").is_err());
        assert!(parse_linux_process("57 (fixture) S 1 2 3").is_err());

        let mut fields = std::iter::once("S".to_owned())
            .chain((1_u64..=21).map(|value| value.to_string()))
            .collect::<Vec<_>>();
        fields[0] = "invalid".to_owned();
        assert!(parse_linux_process(&format!("57 (fixture) {}", fields.join(" "))).is_err());

        fields[0] = "S".to_owned();
        fields[1] = "invalid".to_owned();
        assert!(parse_linux_process(&format!("57 (fixture) {}", fields.join(" "))).is_err());

        fields[1] = "1".to_owned();
        fields[19] = "invalid".to_owned();
        assert!(parse_linux_process(&format!("57 (fixture) {}", fields.join(" "))).is_err());
    }

    #[test]
    fn exact_live_process_requires_matching_marker_and_liveness() {
        let expected = ProcessIdentity::new(41, 73);
        let observation = ProcessObservation {
            identity: expected,
            parent_pid: 7,
            is_alive: true,
        };

        assert!(is_exact_live_process(observation, expected));
        assert!(!is_exact_live_process(
            ProcessObservation {
                identity: ProcessIdentity::new(41, 74),
                ..observation
            },
            expected
        ));
        assert!(!is_exact_live_process(
            ProcessObservation {
                is_alive: false,
                ..observation
            },
            expected
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_start_time_packs_seconds_and_microseconds_without_loss() {
        assert_eq!(
            pack_macos_start_time(0x0123_4567_89ab_cdef, 0xfedc_ba98_7654_3210),
            0x0123_4567_89ab_cdef_fedc_ba98_7654_3210
        );
    }
}
