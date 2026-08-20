use std::{
    fmt, io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};

use tokio::{net::TcpListener, time::Instant};

const LOCAL_GATEWAY_HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
const DEFAULT_WAIT: Duration = Duration::from_secs(5);
const DEFAULT_POLL: Duration = Duration::from_millis(200);
const MIN_POLL: Duration = Duration::from_millis(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GatewayPortAvailable {
    port: u16,
}

impl GatewayPortAvailable {
    pub const fn port(self) -> u16 {
        self.port
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GatewayPortGuardPolicy {
    wait: Duration,
    poll: Duration,
}

impl GatewayPortGuardPolicy {
    pub const fn new(wait: Duration, poll: Duration) -> Self {
        Self { wait, poll }
    }

    pub async fn ensure(self, port: u16) -> Result<GatewayPortAvailable, GatewayPortGuardError> {
        ensure_with_policy(port, self).await
    }
}

impl Default for GatewayPortGuardPolicy {
    fn default() -> Self {
        Self::new(DEFAULT_WAIT, DEFAULT_POLL)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayPortStatus {
    Available(GatewayPortAvailable),
    Occupied(GatewayPortOccupancy),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayPortOccupancy {
    port: u16,
    owner: GatewayPortOwner,
}

impl GatewayPortOccupancy {
    pub const fn port(&self) -> u16 {
        self.port
    }

    pub const fn owner(&self) -> &GatewayPortOwner {
        &self.owner
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayPortOwner {
    MatchaOpenClaw { pid: Option<u32>, command: String },
    Unknown,
}

impl GatewayPortOwner {
    pub const fn is_matcha_openclaw(&self) -> bool {
        matches!(self, Self::MatchaOpenClaw { .. })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayPortGuardError {
    InvalidPort,
    ProbeFailed,
    Occupied(GatewayPortOccupancy),
}

impl fmt::Display for GatewayPortGuardError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPort => output.write_str("OpenClaw gateway port is invalid"),
            Self::ProbeFailed => output.write_str("OpenClaw gateway port probe failed"),
            Self::Occupied(occupancy) => write!(
                output,
                "OpenClaw gateway port {} is already occupied by {}",
                occupancy.port, occupancy.owner
            ),
        }
    }
}

impl std::error::Error for GatewayPortGuardError {}

impl fmt::Display for GatewayPortOwner {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MatchaOpenClaw { pid, command } => match pid {
                Some(pid) => write!(output, "Matcha/OpenClaw process {pid} ({command})"),
                None => write!(output, "Matcha/OpenClaw process ({command})"),
            },
            Self::Unknown => output.write_str("an unknown process"),
        }
    }
}

pub async fn ensure_gateway_port_available(
    port: u16,
) -> Result<GatewayPortAvailable, GatewayPortGuardError> {
    ensure_with_policy(port, GatewayPortGuardPolicy::default()).await
}

pub async fn inspect_gateway_port(port: u16) -> Result<GatewayPortStatus, GatewayPortGuardError> {
    validate_port(port)?;
    match probe_port_once(port).await {
        Ok(true) => Ok(GatewayPortStatus::Available(GatewayPortAvailable { port })),
        Ok(false) => Ok(GatewayPortStatus::Occupied(GatewayPortOccupancy {
            port,
            owner: platform::observe_owner(port),
        })),
        Err(_) => Err(GatewayPortGuardError::ProbeFailed),
    }
}

async fn ensure_with_policy(
    port: u16,
    policy: GatewayPortGuardPolicy,
) -> Result<GatewayPortAvailable, GatewayPortGuardError> {
    validate_port(port)?;
    let started = Instant::now();

    loop {
        let occupancy = match inspect_gateway_port(port).await? {
            GatewayPortStatus::Available(available) => return Ok(available),
            GatewayPortStatus::Occupied(occupancy) => occupancy,
        };

        if started.elapsed() >= policy.wait {
            return Err(GatewayPortGuardError::Occupied(occupancy));
        }

        let remaining = policy.wait.saturating_sub(started.elapsed());
        let poll = if policy.poll < MIN_POLL {
            MIN_POLL
        } else {
            policy.poll
        };
        tokio::time::sleep(remaining.min(poll)).await;
    }
}

async fn probe_port_once(port: u16) -> Result<bool, io::Error> {
    match TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(LOCAL_GATEWAY_HOST, port))).await {
        Ok(listener) => {
            drop(listener);
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => Ok(false),
        Err(error) => Err(error),
    }
}

fn validate_port(port: u16) -> Result<(), GatewayPortGuardError> {
    if port == 0 {
        Err(GatewayPortGuardError::InvalidPort)
    } else {
        Ok(())
    }
}

fn owned_command(pid: Option<u32>, command: String) -> GatewayPortOwner {
    if is_matcha_openclaw_command(&command) {
        GatewayPortOwner::MatchaOpenClaw { pid, command }
    } else {
        GatewayPortOwner::Unknown
    }
}

fn is_matcha_openclaw_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    command.contains("openclaw") || command.contains("matchaclaw") || command.contains("clawdbot")
}

#[cfg(windows)]
mod platform {
    use std::process::Command;

    use super::{GatewayPortOwner, owned_command};

    pub(super) fn observe_owner(port: u16) -> GatewayPortOwner {
        let Some(pid) = listening_pid(port) else {
            return GatewayPortOwner::Unknown;
        };
        let Some(command) = process_image(pid) else {
            return GatewayPortOwner::Unknown;
        };
        owned_command(Some(pid), command)
    }

    fn listening_pid(port: u16) -> Option<u32> {
        let output = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.lines().find_map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() < 5 || columns[0] != "TCP" || columns[3] != "LISTENING" {
                return None;
            }
            address_has_port(columns[1], port)
                .then(|| columns[4].parse().ok())
                .flatten()
        })
    }

    fn process_image(pid: u32) -> Option<String> {
        let filter = format!("PID eq {pid}");
        let output = Command::new("tasklist")
            .args(["/FI", &filter, "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let image = stdout.lines().find_map(first_csv_field)?;
        if image.eq_ignore_ascii_case("INFO") {
            None
        } else {
            Some(image)
        }
    }

    fn address_has_port(address: &str, port: u16) -> bool {
        address.ends_with(&format!(":{port}"))
    }

    fn first_csv_field(line: &str) -> Option<String> {
        let line = line.trim();
        let field = line.strip_prefix('"')?.split("\",").next()?;
        (!field.is_empty()).then(|| field.to_owned())
    }
}

#[cfg(unix)]
mod platform {
    use std::process::Command;

    use super::{GatewayPortOwner, owned_command};

    pub(super) fn observe_owner(port: u16) -> GatewayPortOwner {
        let output = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
            .output();
        let Ok(output) = output else {
            return GatewayPortOwner::Unknown;
        };
        if !output.status.success() {
            return GatewayPortOwner::Unknown;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .lines()
            .skip(1)
            .find_map(parse_lsof_owner)
            .unwrap_or(GatewayPortOwner::Unknown)
    }

    fn parse_lsof_owner(line: &str) -> Option<GatewayPortOwner> {
        let mut columns = line.split_whitespace();
        let command = columns.next()?.to_owned();
        let pid = columns.next().and_then(|value| value.parse().ok());
        Some(owned_command(pid, command))
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    use super::GatewayPortOwner;

    pub(super) fn observe_owner(_port: u16) -> GatewayPortOwner {
        GatewayPortOwner::Unknown
    }
}

#[cfg(test)]
mod tests {
    use std::{net::TcpListener, time::Duration};

    use super::*;

    #[tokio::test]
    async fn rejects_port_zero() {
        assert_eq!(
            ensure_gateway_port_available(0).await,
            Err(GatewayPortGuardError::InvalidPort)
        );
    }

    #[tokio::test]
    async fn reports_available_loopback_port() {
        let port = unused_port();

        assert_eq!(
            GatewayPortGuardPolicy::new(Duration::ZERO, Duration::ZERO)
                .ensure(port)
                .await,
            Ok(GatewayPortAvailable { port })
        );
    }

    #[tokio::test]
    async fn reports_occupied_loopback_port_without_killing_owner() {
        let listener = TcpListener::bind((LOCAL_GATEWAY_HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        let result = GatewayPortGuardPolicy::new(Duration::ZERO, Duration::ZERO)
            .ensure(port)
            .await;

        assert!(matches!(result, Err(GatewayPortGuardError::Occupied(_))));
        drop(listener);
    }

    #[tokio::test]
    async fn waits_until_port_is_released() {
        let listener = TcpListener::bind((LOCAL_GATEWAY_HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(25));
            drop(listener);
        });

        let result = GatewayPortGuardPolicy::new(Duration::from_secs(1), Duration::from_millis(5))
            .ensure(port)
            .await;

        release.join().unwrap();
        assert_eq!(result, Ok(GatewayPortAvailable { port }));
    }

    #[test]
    fn classifies_only_matcha_openclaw_owner_evidence() {
        assert!(owned_command(Some(7), "OpenClaw.exe".into()).is_matcha_openclaw());
        assert!(owned_command(Some(7), "matchaclaw-host".into()).is_matcha_openclaw());
        assert_eq!(
            owned_command(Some(7), "matcha-agent".into()),
            GatewayPortOwner::Unknown
        );
    }

    fn unused_port() -> u16 {
        let listener = TcpListener::bind((LOCAL_GATEWAY_HOST, 0)).unwrap();
        listener.local_addr().unwrap().port()
    }
}
