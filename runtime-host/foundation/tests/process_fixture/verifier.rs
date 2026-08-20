use std::{
    fmt, thread,
    time::{Duration, Instant},
};

use super::{
    platform,
    protocol::{
        FixtureDirectory, Nonce, Phase, ProcessIdentity, ProtocolError, Record, Role, Scenario,
        read_verified_records, unique_record,
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const HOST_RECORDS_TIMEOUT: Duration = Duration::from_secs(15);
const ABSENCE_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn run(
    scenario: Scenario,
    nonce: Nonce,
    directory: FixtureDirectory,
) -> Result<(), VerifierError> {
    let verifier_identity =
        platform::current_identity().map_err(|_| VerifierError::CurrentIdentity)?;
    Record::new(
        nonce.clone(),
        scenario,
        Role::Verifier,
        Phase::Spawned,
        verifier_identity,
    )
    .append_to(&directory)?;

    let mut proven = ProvenHostIdentities::default();
    let result = verify_scenario(scenario, &nonce, &directory, verifier_identity, &mut proven);
    if result.is_err() {
        cleanup_proven_identities(&proven);
    }
    result
}

fn verify_scenario(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
    verifier_identity: ProcessIdentity,
    proven: &mut ProvenHostIdentities,
) -> Result<(), VerifierError> {
    let host = wait_for_host_identities(
        scenario,
        nonce,
        directory,
        Instant::now() + HOST_RECORDS_TIMEOUT,
        proven,
    )?;
    wait_for_required_absences(scenario, host, Instant::now() + ABSENCE_TIMEOUT)?;

    Record::new(
        nonce.clone(),
        scenario,
        Role::Verifier,
        Phase::Terminal,
        verifier_identity,
    )
    .append_to(directory)?;
    Ok(())
}

fn wait_for_host_identities(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
    deadline: Instant,
    proven: &mut ProvenHostIdentities,
) -> Result<HostIdentities, VerifierError> {
    loop {
        if Instant::now() >= deadline {
            return Err(VerifierError::HostRecordsDeadline);
        }

        let records = read_verified_records(directory, nonce)?;
        if records.iter().any(|record| record.scenario() != scenario) {
            return Err(VerifierError::ScenarioMismatch);
        }
        proven.capture(&records)?;
        if let Some(host) = proven.complete() {
            return Ok(host);
        }
        sleep_before(deadline).map_err(|()| VerifierError::HostRecordsDeadline)?;
    }
}

fn wait_for_required_absences(
    scenario: Scenario,
    host: HostIdentities,
    deadline: Instant,
) -> Result<(), VerifierError> {
    match required_state(scenario, host) {
        RequiredState::AllAbsent(identities) => wait_for_exact_absences(&identities, deadline),
        #[cfg(unix)]
        RequiredState::GuardianAndRootAbsent { absent, host } => {
            wait_for_exact_absences(&absent, deadline)?;
            assert!(
                platform::is_exact_identity_alive(host)
                    .expect("fixture supervisor host exact identity observation failed"),
                "fixture supervisor host exact identity did not survive guardian crash"
            );
            Ok(())
        }
    }
}

fn wait_for_exact_absences(
    identities: &[ProcessIdentity],
    deadline: Instant,
) -> Result<(), VerifierError> {
    for (index, identity) in identities.iter().copied().enumerate() {
        if identities[..index].contains(&identity) {
            continue;
        }
        platform::wait_for_exact_exit(identity, deadline)
            .map_err(|_| VerifierError::IdentityAbsence)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequiredState {
    AllAbsent([ProcessIdentity; 3]),
    #[cfg(unix)]
    GuardianAndRootAbsent {
        absent: [ProcessIdentity; 2],
        host: ProcessIdentity,
    },
}

const fn required_state(scenario: Scenario, host: HostIdentities) -> RequiredState {
    match scenario {
        #[cfg(windows)]
        Scenario::WindowsHostKilled => {
            RequiredState::AllAbsent([host.spawned, host.armed, host.ready])
        }
        #[cfg(unix)]
        Scenario::PosixHostEof => RequiredState::AllAbsent([host.spawned, host.armed, host.ready]),
        #[cfg(unix)]
        Scenario::PosixGuardianKilled => RequiredState::GuardianAndRootAbsent {
            absent: [host.armed, host.ready],
            host: host.spawned,
        },
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

#[derive(Clone, Copy)]
struct HostIdentities {
    spawned: ProcessIdentity,
    armed: ProcessIdentity,
    ready: ProcessIdentity,
}

#[derive(Default)]
struct ProvenHostIdentities {
    spawned: Option<ProcessIdentity>,
    armed: Option<ProcessIdentity>,
    ready: Option<ProcessIdentity>,
}

impl ProvenHostIdentities {
    fn capture(&mut self, records: &[Record]) -> Result<(), ProtocolError> {
        capture_identity(records, Phase::Spawned, &mut self.spawned)?;
        capture_identity(records, Phase::Armed, &mut self.armed)?;
        capture_identity(records, Phase::Ready, &mut self.ready)
    }

    const fn complete(&self) -> Option<HostIdentities> {
        match (self.spawned, self.armed, self.ready) {
            (Some(spawned), Some(armed), Some(ready)) => Some(HostIdentities {
                spawned,
                armed,
                ready,
            }),
            _ => None,
        }
    }
}

fn capture_identity(
    records: &[Record],
    phase: Phase,
    destination: &mut Option<ProcessIdentity>,
) -> Result<(), ProtocolError> {
    match unique_record(records, Role::SupervisorHost, phase) {
        Ok(record) => {
            *destination = Some(record.identity());
            Ok(())
        }
        Err(ProtocolError::RecordNotFound) => Ok(()),
        Err(error) => Err(error),
    }
}

fn cleanup_proven_identities(proven: &ProvenHostIdentities) {
    let identities = [proven.ready, proven.armed, proven.spawned];
    for index in 0..identities.len() {
        let Some(identity) = identities[index] else {
            continue;
        };
        if identities[..index].contains(&Some(identity)) {
            continue;
        }
        let _ = platform::hard_kill_exact(identity);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VerifierError {
    CurrentIdentity,
    ScenarioMismatch,
    HostRecordsDeadline,
    IdentityAbsence,
    Protocol(ProtocolError),
}

impl From<ProtocolError> for VerifierError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

impl fmt::Display for VerifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CurrentIdentity => "fixture verifier identity observation failed",
            Self::ScenarioMismatch => "fixture record scenario does not match",
            Self::HostRecordsDeadline => "fixture supervisor host records deadline elapsed",
            Self::IdentityAbsence => "fixture exact identity absence was not proven",
            Self::Protocol(error) => return error.fmt(formatter),
        })
    }
}

impl std::error::Error for VerifierError {
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

    #[cfg(windows)]
    const SCENARIO: Scenario = Scenario::WindowsHostKilled;
    #[cfg(unix)]
    const SCENARIO: Scenario = Scenario::PosixHostEof;

    const HOST: HostIdentities = HostIdentities {
        spawned: ProcessIdentity::new(11, 101),
        armed: ProcessIdentity::new(12, 102),
        ready: ProcessIdentity::new(13, 103),
    };

    #[test]
    fn captures_only_verified_supervisor_host_phases() {
        let nonce = Nonce::generate();
        let records = [
            Record::new(
                nonce.clone(),
                SCENARIO,
                Role::Verifier,
                Phase::Spawned,
                ProcessIdentity::new(99, 199),
            ),
            Record::new(
                nonce.clone(),
                SCENARIO,
                Role::SupervisorHost,
                Phase::Spawned,
                HOST.spawned,
            ),
            Record::new(
                nonce.clone(),
                SCENARIO,
                Role::SupervisorHost,
                Phase::Armed,
                HOST.armed,
            ),
            Record::new(
                nonce,
                SCENARIO,
                Role::SupervisorHost,
                Phase::Ready,
                HOST.ready,
            ),
        ];
        let mut proven = ProvenHostIdentities::default();

        proven.capture(&records).unwrap();
        let captured = proven.complete().unwrap();

        assert_eq!(captured.spawned, HOST.spawned);
        assert_eq!(captured.armed, HOST.armed);
        assert_eq!(captured.ready, HOST.ready);
    }

    #[test]
    fn host_loss_scenarios_require_all_exact_identities_absent() {
        #[cfg(windows)]
        let scenarios = [Scenario::WindowsHostKilled];
        #[cfg(unix)]
        let scenarios = [Scenario::PosixHostEof];

        for scenario in scenarios {
            assert_eq!(
                required_state(scenario, HOST),
                RequiredState::AllAbsent([HOST.spawned, HOST.armed, HOST.ready]),
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn guardian_crash_requires_guardian_and_root_absent_but_host_alive() {
        assert_eq!(
            required_state(Scenario::PosixGuardianKilled, HOST),
            RequiredState::GuardianAndRootAbsent {
                absent: [HOST.armed, HOST.ready],
                host: HOST.spawned,
            },
        );
    }
}
