//! Native SSH effects for Fleet targets.
//!
//! This module is deliberately the only SSH owner in Host. It performs the
//! protocol itself; no shell/argv fallback is used. Credentials are resolved
//! only for the duration of an operation and are never included in results.

use std::{
    fmt,
    sync::Arc,
    time::{Duration, SystemTime},
};

use crate as fleet;
use tokio::sync::mpsc;

use fleet::{FleetSecretResolution, FleetSecretResolverPort, SshAuthentication, SshTargetConfig};
use russh::{
    ChannelMsg, Disconnect,
    client::{self, AuthResult, Handle, Handler},
    keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey},
};
use tokio::time::timeout;

use super::provider_resource::{ProviderResourceProvider, ProviderResourceReceipt};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug)]
pub(crate) struct SshTimeouts {
    connect: Duration,
    command: Duration,
}

impl Default for SshTimeouts {
    fn default() -> Self {
        Self {
            connect: CONNECT_TIMEOUT,
            command: COMMAND_TIMEOUT,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct SshOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: u32,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum SshEffectError {
    InvalidConfig,
    SecretUnavailable,
    SecretDenied,
    SecretMissing,
    InvalidPrivateKey,
    HostKeyMismatch,
    AuthenticationFailed,
    Timeout,
    Network,
    RemoteExit(u32),
    RemoteSignal,
    Protocol,
    UnsupportedUninstall,
}

impl fmt::Display for SshEffectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig => f.write_str("invalid SSH configuration"),
            Self::SecretUnavailable => f.write_str("SSH secret resolver unavailable"),
            Self::SecretDenied => f.write_str("SSH secret access denied"),
            Self::SecretMissing => f.write_str("SSH secret not found"),
            Self::InvalidPrivateKey => f.write_str("invalid SSH private key"),
            Self::HostKeyMismatch => f.write_str("SSH host key mismatch"),
            Self::AuthenticationFailed => f.write_str("SSH authentication failed"),
            Self::Timeout => f.write_str("SSH operation timed out"),
            Self::Network => f.write_str("SSH network operation failed"),
            Self::RemoteExit(code) => write!(f, "SSH command exited with status {code}"),
            Self::RemoteSignal => f.write_str("SSH command terminated by signal"),
            Self::Protocol => f.write_str("SSH protocol operation failed"),
            Self::UnsupportedUninstall => f.write_str(
                "SSH agent uninstall is unsupported by the configured install semantics",
            ),
        }
    }
}
impl std::error::Error for SshEffectError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SshLifecycleEffect {
    Probe,
    Provision,
    Delete,
}

impl SshLifecycleEffect {
    pub(crate) const fn lifecycle_timeout(self) -> Duration {
        match self {
            Self::Probe => CONNECT_TIMEOUT,
            Self::Provision => COMMAND_TIMEOUT,
            Self::Delete => Duration::ZERO,
        }
    }
}

/// SSH has no provider API resource identity. A successful install therefore
/// cannot produce a managed-resource fact; this receipt makes that boundary explicit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SshResourceReadback {
    pub(crate) receipt: ProviderResourceReceipt,
}

impl SshResourceReadback {
    pub(crate) fn no_authoritative_identity(observed_at: SystemTime) -> Self {
        Self {
            receipt: ProviderResourceReceipt::NoAuthoritativeResourceIdentity {
                provider: ProviderResourceProvider::Ssh,
                observed_at,
            },
        }
    }

    pub(crate) fn has_no_fact(&self) -> bool {
        self.receipt.is_no_fact()
    }
}

/// Source-backed authority for SSH uninstall. The typed SSH configuration
/// contains installation semantics only; it has no authoritative uninstall
/// command, so this authority deliberately carries no command to execute.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SshUninstallAuthority {
    Unsupported,
}

/// Receipt of consulting the SSH uninstall authority. `Unsupported` is a
/// durable negative fact, not an unknown remote outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SshUninstallReceipt {
    Unsupported,
}

impl SshUninstallAuthority {
    pub(crate) fn for_target(_target: &SshTargetConfig) -> Self {
        Self::Unsupported
    }

    pub(crate) const fn command(self) -> Option<&'static str> {
        match self {
            Self::Unsupported => None,
        }
    }

    pub(crate) const fn receipt(self) -> SshUninstallReceipt {
        match self {
            Self::Unsupported => SshUninstallReceipt::Unsupported,
        }
    }
}

impl SshUninstallReceipt {
    pub(crate) const fn error(self) -> SshEffectError {
        match self {
            Self::Unsupported => SshEffectError::UnsupportedUninstall,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SshEffect {
    timeouts: SshTimeouts,
}
impl Default for SshEffect {
    fn default() -> Self {
        Self::new(SshTimeouts::default())
    }
}

impl SshEffect {
    pub(crate) const fn new(timeouts: SshTimeouts) -> Self {
        Self { timeouts }
    }

    pub(crate) async fn connect<R>(
        &self,
        target: &SshTargetConfig,
        resolver: &mut R,
        pinned_host_key: &PublicKey,
    ) -> Result<SshConnection, SshEffectError>
    where
        R: FleetSecretResolverPort,
        R::Secret: AsRef<str>,
    {
        let credential = resolve_credential(target, resolver)?;
        let username = target.username().ok_or(SshEffectError::InvalidConfig)?;
        let port = target.port().unwrap_or(22);
        let handler = PinnedHandler {
            expected: pinned_host_key.clone(),
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(self.timeouts.command),
            ..Default::default()
        });
        let mut session = timeout(
            self.timeouts.connect,
            client::connect(config, (target.host(), port), handler),
        )
        .await
        .map_err(|_| SshEffectError::Timeout)?
        .map_err(map_connect_error)?;
        let auth = match credential {
            Credential::Password(password) => session
                .authenticate_password(username, password)
                .await
                .map_err(|_| SshEffectError::Network)?,
            Credential::PrivateKey(key) => {
                let private = PrivateKey::from_openssh(key.as_bytes())
                    .map_err(|_| SshEffectError::InvalidPrivateKey)?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|_| SshEffectError::Protocol)?
                    .flatten();
                session
                    .authenticate_publickey(
                        username,
                        PrivateKeyWithHashAlg::new(Arc::new(private), hash),
                    )
                    .await
                    .map_err(|_| SshEffectError::Network)?
            }
        };
        if !matches!(auth, AuthResult::Success) {
            return Err(SshEffectError::AuthenticationFailed);
        }
        Ok(SshConnection {
            session,
            timeouts: self.timeouts,
        })
    }

    pub(crate) async fn probe<R>(
        &self,
        target: &SshTargetConfig,
        resolver: &mut R,
        pinned_host_key: &PublicKey,
    ) -> Result<(), SshEffectError>
    where
        R: FleetSecretResolverPort,
        R::Secret: AsRef<str>,
    {
        self.connect(target, resolver, pinned_host_key)
            .await?
            .close()
            .await
    }

    pub(crate) async fn exec<R>(
        &self,
        target: &SshTargetConfig,
        resolver: &mut R,
        pinned_host_key: &PublicKey,
        command: &str,
        secret_values: &[&str],
    ) -> Result<SshOutput, SshEffectError>
    where
        R: FleetSecretResolverPort,
        R::Secret: AsRef<str>,
    {
        self.connect(target, resolver, pinned_host_key)
            .await?
            .exec(command, secret_values)
            .await
    }

    pub(crate) async fn install<R>(
        &self,
        target: &SshTargetConfig,
        resolver: &mut R,
        pinned_host_key: &PublicKey,
        environment: &[(&str, &str)],
    ) -> Result<SshOutput, SshEffectError>
    where
        R: FleetSecretResolverPort,
        R::Secret: AsRef<str>,
    {
        let command = environment
            .iter()
            .map(|(name, value)| format!("{name}={}", shell_quote(value)))
            .chain(std::iter::once(target.install_command().to_owned()))
            .collect::<Vec<_>>()
            .join(" ");
        let secrets = environment
            .iter()
            .map(|(_, value)| *value)
            .collect::<Vec<_>>();
        self.exec(target, resolver, pinned_host_key, &command, &secrets)
            .await
    }

    /// SSH configuration supplies installation only. Without a source-backed
    /// uninstall command, deletion must be an explicit unsupported result.
    pub(crate) async fn execute_lifecycle<R>(
        &self,
        effect: SshLifecycleEffect,
        target: &SshTargetConfig,
        resolver: &mut R,
        pinned_host_key: &PublicKey,
    ) -> Result<Option<SshOutput>, SshEffectError>
    where
        R: FleetSecretResolverPort,
        R::Secret: AsRef<str>,
    {
        match effect {
            SshLifecycleEffect::Probe => {
                self.probe(target, resolver, pinned_host_key).await?;
                Ok(None)
            }
            SshLifecycleEffect::Provision => self
                .install(target, resolver, pinned_host_key, &[])
                .await
                .map(Some),
            SshLifecycleEffect::Delete => {
                let receipt = SshUninstallAuthority::for_target(target).receipt();
                Err(receipt.error())
            }
        }
    }

    /// Runs the SSH lifecycle but deliberately returns no managed-resource fact.
    /// SSH exposes installation semantics, not an authoritative resource identity.
    pub(crate) async fn execute_lifecycle_readback<R>(
        &self,
        effect: SshLifecycleEffect,
        target: &SshTargetConfig,
        resolver: &mut R,
        pinned_host_key: &PublicKey,
        observed_at: SystemTime,
    ) -> Result<SshResourceReadback, SshEffectError>
    where
        R: FleetSecretResolverPort,
        R::Secret: AsRef<str>,
    {
        self.execute_lifecycle(effect, target, resolver, pinned_host_key)
            .await?;
        Ok(SshResourceReadback::no_authoritative_identity(observed_at))
    }
}

pub(crate) struct SshConnection {
    session: Handle<PinnedHandler>,
    timeouts: SshTimeouts,
}

pub(crate) async fn open_terminal<R>(
    target: &SshTargetConfig,
    resolver: &mut R,
    pinned_host_key: &PublicKey,
    rows: u16,
    cols: u16,
) -> Result<
    (
        mpsc::Sender<crate::application::terminal::ProviderCommand>,
        mpsc::Receiver<
            Result<
                crate::application::terminal::ProviderEvent,
                crate::application::terminal::ProviderError,
            >,
        >,
    ),
    SshEffectError,
>
where
    R: FleetSecretResolverPort,
    R::Secret: AsRef<str>,
{
    let connection = SshEffect::default()
        .connect(target, resolver, pinned_host_key)
        .await?;
    let mut channel = connection
        .session
        .channel_open_session()
        .await
        .map_err(|_| SshEffectError::Protocol)?;
    channel
        .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|_| SshEffectError::Protocol)?;
    channel
        .request_shell(true)
        .await
        .map_err(|_| SshEffectError::Protocol)?;
    let (commands_tx, mut commands_rx) = mpsc::channel(32);
    let (events_tx, events_rx) = mpsc::channel(32);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                command = commands_rx.recv() => match command {
                    Some(crate::application::terminal::ProviderCommand::Input(data)) => {
                        if channel.data_bytes(data).await.is_err() { break; }
                    }
                    Some(crate::application::terminal::ProviderCommand::Resize { rows, cols }) => {
                        if channel.window_change(cols as u32, rows as u32, 0, 0).await.is_err() { break; }
                    }
                    None => { let _ = channel.eof().await; break; }
                },
                message = channel.wait() => match message {
                    Some(russh::ChannelMsg::Data { data }) => {
                        if events_tx.send(Ok(crate::application::terminal::ProviderEvent::Output(data.to_vec()))).await.is_err() { break; }
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        if events_tx.send(Ok(crate::application::terminal::ProviderEvent::Output(data.to_vec()))).await.is_err() { break; }
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = events_tx.send(Ok(crate::application::terminal::ProviderEvent::Exit { code: i32::try_from(exit_status).ok() })).await;
                    }
                    Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    });
    Ok((commands_tx, events_rx))
}
impl SshConnection {
    async fn exec(
        self,
        command: &str,
        secret_values: &[&str],
    ) -> Result<SshOutput, SshEffectError> {
        let operation = async {
            let mut channel = self
                .session
                .channel_open_session()
                .await
                .map_err(|_| SshEffectError::Protocol)?;
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(|_| SshEffectError::Protocol)?;
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            let mut signalled = false;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => append_bounded(&mut stdout, &data),
                    ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                        append_bounded(&mut stderr, &data)
                    }
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::ExitSignal { .. } => signalled = true,
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            if signalled {
                return Err(SshEffectError::RemoteSignal);
            }
            let exit_code = exit_code.ok_or(SshEffectError::Protocol)?;
            if exit_code != 0 {
                return Err(SshEffectError::RemoteExit(exit_code));
            }
            Ok(SshOutput {
                stdout: redact(String::from_utf8_lossy(&stdout).into_owned(), secret_values),
                stderr: redact(String::from_utf8_lossy(&stderr).into_owned(), secret_values),
                exit_code,
            })
        };
        let result = timeout(self.timeouts.command, operation)
            .await
            .map_err(|_| SshEffectError::Timeout)?;
        let _ = self
            .session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        result
    }
    async fn close(self) -> Result<(), SshEffectError> {
        timeout(
            self.timeouts.connect,
            self.session.disconnect(Disconnect::ByApplication, "", "en"),
        )
        .await
        .map_err(|_| SshEffectError::Timeout)?
        .map_err(|_| SshEffectError::Network)
    }
}

struct PinnedHandler {
    expected: PublicKey,
}
impl Handler for PinnedHandler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(key == &self.expected)
    }
}

enum Credential {
    PrivateKey(String),
    Password(String),
}
fn map_connect_error(error: russh::Error) -> SshEffectError {
    if matches!(error, russh::Error::UnknownKey) {
        SshEffectError::HostKeyMismatch
    } else {
        SshEffectError::Network
    }
}

fn resolve_credential<R>(
    target: &SshTargetConfig,
    resolver: &mut R,
) -> Result<Credential, SshEffectError>
where
    R: FleetSecretResolverPort,
    R::Secret: AsRef<str>,
{
    let value = resolver
        .resolve(target.authentication().secret_reference())
        .map_err(|_| SshEffectError::SecretUnavailable)?;
    let value = match value {
        FleetSecretResolution::Resolved(value) if !value.as_ref().is_empty() => {
            value.as_ref().to_owned()
        }
        FleetSecretResolution::Resolved(_) | FleetSecretResolution::NotFound => {
            return Err(SshEffectError::SecretMissing);
        }
        FleetSecretResolution::AccessDenied => return Err(SshEffectError::SecretDenied),
    };
    Ok(match target.authentication() {
        SshAuthentication::PrivateKey(_) => Credential::PrivateKey(value),
        SshAuthentication::Password(_) => Credential::Password(value),
    })
}

fn append_bounded(output: &mut Vec<u8>, data: &[u8]) {
    if data.len() >= MAX_OUTPUT_BYTES {
        output.clear();
        output.extend_from_slice(&data[data.len() - MAX_OUTPUT_BYTES..]);
        return;
    }
    let overflow = output
        .len()
        .saturating_add(data.len())
        .saturating_sub(MAX_OUTPUT_BYTES);
    if overflow > 0 {
        output.drain(..overflow);
    }
    output.extend_from_slice(data);
}
fn redact(mut value: String, secrets: &[&str]) -> String {
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "[redacted]");
    }
    value
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_output_keeps_only_the_tail() {
        let mut output = Vec::new();
        append_bounded(&mut output, &vec![b'a'; MAX_OUTPUT_BYTES + 4]);
        assert_eq!(output.len(), MAX_OUTPUT_BYTES);
        append_bounded(&mut output, b"tail");
        assert_eq!(&output[MAX_OUTPUT_BYTES - 4..], b"tail");
    }
    #[test]
    fn shell_quote_and_redaction_are_secret_safe() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(
            redact("prefix secret suffix".into(), &["secret"]),
            "prefix [redacted] suffix"
        );
    }

    #[test]
    fn pinned_key_rejection_is_a_definitive_failure() {
        assert_eq!(
            map_connect_error(russh::Error::UnknownKey),
            SshEffectError::HostKeyMismatch
        );
    }

    #[test]
    fn uninstall_authority_is_explicitly_unsupported_without_a_command() {
        let target = fleet::SshTargetConfig::try_new(
            "node.example.test",
            Some(22),
            Some("operator".into()),
            fleet::SshAuthentication::Password(
                fleet::FleetSecretRef::parse("remote-fleet://credentials/ssh").unwrap(),
            ),
            "install-agent",
        )
        .unwrap();
        let authority = SshUninstallAuthority::for_target(&target);
        assert_eq!(authority, SshUninstallAuthority::Unsupported);
        assert_eq!(authority.command(), None);
        assert_eq!(authority.receipt(), SshUninstallReceipt::Unsupported);
        assert_eq!(
            authority.receipt().error(),
            SshEffectError::UnsupportedUninstall
        );
    }
}
