#[cfg(any(unix, windows))]
#[path = "process_fixture/driver.rs"]
mod driver;
#[cfg(windows)]
#[path = "process_fixture/platform/windows.rs"]
mod platform;
#[cfg(unix)]
#[path = "process_fixture/platform/posix.rs"]
mod platform;
#[cfg(any(unix, windows))]
#[path = "process_fixture/protocol.rs"]
mod protocol;
#[cfg(any(unix, windows))]
#[path = "process_fixture/supervisor_host.rs"]
mod supervisor_host;
#[cfg(any(unix, windows))]
#[path = "process_fixture/verifier.rs"]
mod verifier;

#[cfg(any(unix, windows))]
const ROLE_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_ROLE";
#[cfg(any(unix, windows))]
const SCENARIO_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_SCENARIO";
#[cfg(any(unix, windows))]
const NONCE_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_NONCE";
#[cfg(any(unix, windows))]
const DIRECTORY_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_DIRECTORY";

#[cfg(any(unix, windows))]
#[tokio::test]
async fn owned_processes_exit_after_authority_failure() {
    if let Some(role) = fixture_role() {
        let scenario = parse_scenario();
        let nonce = parse_nonce();
        let directory = fixture_directory();
        dispatch_role(role, scenario, nonce, directory).await;
        return;
    }

    #[cfg(windows)]
    driver::run(protocol::Scenario::WindowsHostKilled).unwrap();

    #[cfg(unix)]
    for scenario in [
        protocol::Scenario::PosixHostEof,
        protocol::Scenario::PosixGuardianKilled,
    ] {
        driver::run(scenario).unwrap();
    }
}

#[cfg(any(unix, windows))]
async fn dispatch_role(
    role: protocol::Role,
    scenario: protocol::Scenario,
    nonce: protocol::Nonce,
    directory: protocol::FixtureDirectory,
) {
    match role {
        protocol::Role::Driver => panic!("fixture driver role must not be dispatched"),
        protocol::Role::SupervisorHost => {
            supervisor_host::run(scenario, nonce, directory)
                .await
                .unwrap();
        }
        protocol::Role::Verifier => verifier::run(scenario, nonce, directory).unwrap(),
    }
}

#[cfg(any(unix, windows))]
fn fixture_role() -> Option<protocol::Role> {
    match std::env::var(ROLE_ENV) {
        Ok(value) => Some(protocol::Role::parse(&value).expect("fixture role is malformed")),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("fixture role is not Unicode"),
    }
}

#[cfg(any(unix, windows))]
fn parse_scenario() -> protocol::Scenario {
    let value = std::env::var(SCENARIO_ENV).expect("fixture scenario is missing or not Unicode");
    protocol::Scenario::parse(&value).expect("fixture scenario is malformed")
}

#[cfg(any(unix, windows))]
fn parse_nonce() -> protocol::Nonce {
    let value = std::env::var(NONCE_ENV).expect("fixture nonce is missing or not Unicode");
    protocol::Nonce::parse(&value).expect("fixture nonce is malformed")
}

#[cfg(any(unix, windows))]
fn fixture_directory() -> protocol::FixtureDirectory {
    let path = std::env::var_os(DIRECTORY_ENV).expect("fixture directory is missing");
    assert!(!path.is_empty(), "fixture directory is empty");
    protocol::FixtureDirectory::from_existing(path.into())
}
