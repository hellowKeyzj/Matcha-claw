use std::{
    env, fmt,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

use super::{
    DIRECTORY_ENV, NONCE_ENV, ROLE_ENV, SCENARIO_ENV, platform,
    protocol::{
        FixtureDirectory, Nonce, Phase, ProcessIdentity, ProtocolError, Record, Role, Scenario,
        read_verified_records, unique_record,
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const HOST_READY_TIMEOUT: Duration = Duration::from_secs(15);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(15);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn run(scenario: Scenario) -> Result<(), DriverError> {
    let nonce = Nonce::generate();
    let directory = FixtureDirectory::create(&nonce)?;
    let driver_identity = platform::current_identity().map_err(|_| DriverError::CurrentIdentity)?;
    Record::new(
        nonce.clone(),
        scenario,
        Role::Driver,
        Phase::Spawned,
        driver_identity,
    )
    .append_to(&directory)?;

    let mut host = spawn_supervisor_host(scenario, &nonce, &directory)?;
    let result = drive_scenario(scenario, &nonce, &directory, &mut host);
    if result.is_err() {
        cleanup_proven_identities(scenario, &nonce, &directory, &mut host);
    }
    result
}

fn spawn_supervisor_host(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
) -> Result<Child, DriverError> {
    let executable = env::current_exe().map_err(|_| DriverError::CurrentExecutable)?;
    let current_thread = thread::current();
    let test_name = current_thread.name().ok_or(DriverError::UnnamedTest)?;

    Command::new(executable)
        .arg(test_name)
        .arg("--exact")
        .env_clear()
        .env(ROLE_ENV, Role::SupervisorHost.as_str())
        .env(SCENARIO_ENV, scenario.as_str())
        .env(NONCE_ENV, nonce.as_str())
        .env(DIRECTORY_ENV, directory.path())
        .spawn()
        .map_err(|_| DriverError::HostSpawn)
}

fn drive_scenario(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
    host: &mut Child,
) -> Result<(), DriverError> {
    let ready_deadline = Instant::now() + HOST_READY_TIMEOUT;
    let identities = HostIdentities {
        host: wait_for_identity(
            scenario,
            nonce,
            directory,
            Role::SupervisorHost,
            Phase::Spawned,
            ready_deadline,
        )?,
    };
    #[cfg(windows)]
    wait_for_identity(
        scenario,
        nonce,
        directory,
        Role::SupervisorHost,
        Phase::Armed,
        ready_deadline,
    )?;
    #[cfg(unix)]
    let authority_anchor = wait_for_identity(
        scenario,
        nonce,
        directory,
        Role::SupervisorHost,
        Phase::Armed,
        ready_deadline,
    )?;
    let _target_root = wait_for_identity(
        scenario,
        nonce,
        directory,
        Role::SupervisorHost,
        Phase::Ready,
        ready_deadline,
    )?;
    if identities.host.pid() != host.id() {
        return Err(DriverError::HostIdentityMismatch);
    }

    #[cfg(windows)]
    let trigger = trigger_identity(scenario, identities);
    #[cfg(unix)]
    let trigger = trigger_identity(scenario, identities, authority_anchor);
    platform::hard_kill_exact(trigger).map_err(|_| DriverError::ScenarioTrigger)?;

    let completion_deadline = Instant::now() + COMPLETION_TIMEOUT;
    wait_for_identity(
        scenario,
        nonce,
        directory,
        Role::Verifier,
        Phase::Terminal,
        completion_deadline,
    )?;
    if needs_post_verification_host_cleanup(scenario) {
        platform::hard_kill_exact(identities.host).map_err(|_| DriverError::HostCleanup)?;
    }
    reap_host(host, completion_deadline)
}

fn wait_for_identity(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
    role: Role,
    phase: Phase,
    deadline: Instant,
) -> Result<ProcessIdentity, DriverError> {
    loop {
        if Instant::now() >= deadline {
            return Err(DriverError::PhaseDeadline { role, phase });
        }

        let records = read_verified_records(directory, nonce)?;
        if records.iter().any(|record| record.scenario() != scenario) {
            return Err(DriverError::ScenarioMismatch);
        }
        match unique_record(&records, role, phase) {
            Ok(record) => return Ok(record.identity()),
            Err(ProtocolError::RecordNotFound) => {
                sleep_before(deadline).map_err(|()| DriverError::PhaseDeadline { role, phase })?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn sleep_before(deadline: Instant) -> Result<(), ()> {
    let now = Instant::now();
    if now >= deadline {
        return Err(());
    }
    thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    Ok(())
}

fn reap_host(host: &mut Child, deadline: Instant) -> Result<(), DriverError> {
    loop {
        match host.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                sleep_before(deadline).map_err(|()| DriverError::HostReapDeadline)?;
            }
            Err(_) => return Err(DriverError::HostReap),
        }
    }
}

#[derive(Clone, Copy)]
struct HostIdentities {
    host: ProcessIdentity,
}

#[cfg(windows)]
const fn trigger_identity(scenario: Scenario, identities: HostIdentities) -> ProcessIdentity {
    match scenario {
        Scenario::WindowsHostKilled => identities.host,
    }
}

#[cfg(unix)]
const fn trigger_identity(
    scenario: Scenario,
    identities: HostIdentities,
    authority_anchor: ProcessIdentity,
) -> ProcessIdentity {
    match scenario {
        Scenario::PosixHostEof => identities.host,
        Scenario::PosixGuardianKilled => authority_anchor,
    }
}

const fn needs_post_verification_host_cleanup(scenario: Scenario) -> bool {
    match scenario {
        #[cfg(windows)]
        Scenario::WindowsHostKilled => false,
        #[cfg(unix)]
        Scenario::PosixHostEof => false,
        #[cfg(unix)]
        Scenario::PosixGuardianKilled => true,
    }
}

fn cleanup_proven_identities(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
    host: &mut Child,
) {
    let Ok(records) = read_verified_records(directory, nonce) else {
        return;
    };
    if records.iter().any(|record| record.scenario() != scenario) {
        return;
    }

    let mut killed = Vec::new();
    for phase in [Phase::Ready, Phase::Armed, Phase::Spawned] {
        let Ok(record) = unique_record(&records, Role::SupervisorHost, phase) else {
            continue;
        };
        let identity = record.identity();
        if killed.contains(&identity) {
            continue;
        }
        let _ = platform::hard_kill_exact(identity);
        killed.push(identity);
    }

    let _ = reap_host(host, Instant::now() + CLEANUP_TIMEOUT);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DriverError {
    CurrentIdentity,
    CurrentExecutable,
    UnnamedTest,
    HostSpawn,
    HostIdentityMismatch,
    ScenarioMismatch,
    PhaseDeadline { role: Role, phase: Phase },
    ScenarioTrigger,
    HostCleanup,
    HostReap,
    HostReapDeadline,
    Protocol(ProtocolError),
}

impl From<ProtocolError> for DriverError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

impl fmt::Display for DriverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentIdentity => {
                formatter.write_str("fixture driver identity observation failed")
            }
            Self::CurrentExecutable => {
                formatter.write_str("fixture test executable resolution failed")
            }
            Self::UnnamedTest => formatter.write_str("fixture driver requires a named libtest"),
            Self::HostSpawn => formatter.write_str("fixture supervisor host spawn failed"),
            Self::HostIdentityMismatch => {
                formatter.write_str("fixture supervisor host identity does not match its child")
            }
            Self::ScenarioMismatch => formatter.write_str("fixture record scenario does not match"),
            Self::PhaseDeadline { role, phase } => write!(
                formatter,
                "fixture deadline elapsed before {}/{}",
                role.as_str(),
                phase.as_str()
            ),
            Self::ScenarioTrigger => formatter.write_str("fixture scenario trigger failed"),
            Self::HostCleanup => formatter.write_str("fixture supervisor host cleanup failed"),
            Self::HostReap => formatter.write_str("fixture supervisor host reap failed"),
            Self::HostReapDeadline => {
                formatter.write_str("fixture supervisor host reap deadline elapsed")
            }
            Self::Protocol(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for DriverError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITIES: HostIdentities = HostIdentities {
        host: ProcessIdentity::new(11, 101),
    };
    #[cfg(unix)]
    const AUTHORITY_ANCHOR: ProcessIdentity = ProcessIdentity::new(12, 102);

    #[cfg(windows)]
    #[test]
    fn windows_host_kill_targets_the_recorded_host_identity() {
        assert_eq!(
            trigger_identity(Scenario::WindowsHostKilled, IDENTITIES),
            IDENTITIES.host
        );
    }

    #[cfg(unix)]
    #[test]
    fn posix_host_eof_targets_the_recorded_host_identity() {
        assert_eq!(
            trigger_identity(Scenario::PosixHostEof, IDENTITIES, AUTHORITY_ANCHOR),
            IDENTITIES.host
        );
    }

    #[cfg(unix)]
    #[test]
    fn posix_guardian_crash_targets_the_recorded_authority_anchor() {
        assert_eq!(
            trigger_identity(Scenario::PosixGuardianKilled, IDENTITIES, AUTHORITY_ANCHOR),
            AUTHORITY_ANCHOR
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_host_kill_needs_no_post_verification_cleanup_trigger() {
        assert!(!needs_post_verification_host_cleanup(
            Scenario::WindowsHostKilled
        ));
    }

    #[cfg(unix)]
    #[test]
    fn only_guardian_crash_cleans_up_the_recorded_host_after_verification() {
        assert!(!needs_post_verification_host_cleanup(
            Scenario::PosixHostEof
        ));
        assert!(needs_post_verification_host_cleanup(
            Scenario::PosixGuardianKilled
        ));
    }
}
