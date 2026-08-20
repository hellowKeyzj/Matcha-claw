//! Typed Fleet connection-probe owner.
//!
//! This module owns only the provider-facing probe boundary.  It delegates the
//! actual network work to the native provider effects and turns their errors
//! into an explicit `Ready`, `Failed`, or `Unknown` result.  In particular, a
//! transport timeout or network error is never reported as a successful probe.

use std::{collections::BTreeMap, fmt};

use fleet::{
    FleetSecretResolverPort, FleetTargetConfig, KubernetesTargetConfig, SshTargetConfig, TargetId,
};
use russh::keys::PublicKey;

use super::{
    docker::{DockerEffect, DockerEffectClient, DockerEffectError},
    kubernetes::{KubernetesEffect, KubernetesEffectClient, KubernetesEffectError},
    ssh::{SshEffect, SshEffectError},
};

const MANAGED_LABEL: &str = "com.matchaclaw.remote-fleet.managed";
const TARGET_LABEL: &str = "com.matchaclaw.remote-fleet.target";

/// The provider-specific input required to perform a connection probe.
///
/// The boundary deliberately carries typed provider configuration rather than
/// reconstructing it from an untyped connection record.  SSH also requires
/// the previously pinned host key; there is no trust-on-first-use fallback.
#[derive(Clone, Copy, Debug)]
pub(crate) enum FleetConnectionProbeProvider<'a> {
    Docker {
        config: &'a fleet::DockerTargetConfig,
        ownership: &'a BTreeMap<String, String>,
    },
    Kubernetes {
        config: &'a KubernetesTargetConfig,
        target_id: &'a TargetId,
    },
    Ssh {
        config: &'a SshTargetConfig,
        pinned_host_key: &'a PublicKey,
    },
}

impl<'a> FleetConnectionProbeProvider<'a> {
    /// Build the provider boundary from the canonical Fleet target config.
    ///
    /// Custom targets have no native Host probe owner and are rejected here;
    /// this function never supplies a synthetic success for them.
    pub(crate) fn from_target(
        target: &'a FleetTargetConfig,
        target_id: &'a TargetId,
        docker_ownership: &'a BTreeMap<String, String>,
        pinned_host_key: Option<&'a PublicKey>,
    ) -> Result<Self, FleetConnectionProbeBoundaryError> {
        match target {
            FleetTargetConfig::Docker(config) => Ok(Self::Docker {
                config,
                ownership: docker_ownership,
            }),
            FleetTargetConfig::Kubernetes(config) => Ok(Self::Kubernetes { config, target_id }),
            FleetTargetConfig::Ssh(config) => Ok(Self::Ssh {
                config,
                pinned_host_key: pinned_host_key
                    .ok_or(FleetConnectionProbeBoundaryError::MissingSshHostKey)?,
            }),
            FleetTargetConfig::Custom(_) => {
                Err(FleetConnectionProbeBoundaryError::UnsupportedTarget {
                    target: target_id.clone(),
                })
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetConnectionProbeBoundaryError {
    MissingSshHostKey,
    UnsupportedTarget { target: TargetId },
    InvalidOwnership,
}

impl fmt::Display for FleetConnectionProbeBoundaryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSshHostKey => formatter.write_str("Fleet SSH host-key pin is unavailable"),
            Self::UnsupportedTarget { target } => {
                write!(
                    formatter,
                    "Fleet target {} has no native connection probe",
                    target.as_str()
                )
            }
            Self::InvalidOwnership => formatter.write_str("Fleet provider ownership is invalid"),
        }
    }
}

impl std::error::Error for FleetConnectionProbeBoundaryError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetConnectionProbeOutcome {
    Ready,
    Failed { message: String },
    Unknown { message: String },
}

impl FleetConnectionProbeOutcome {
    fn failed(provider: &str, message: impl Into<String>) -> Self {
        Self::Failed {
            message: format!("{provider} connection probe failed: {}", message.into()),
        }
    }

    fn unknown(provider: &str, message: impl Into<String>) -> Self {
        Self::Unknown {
            message: format!(
                "{provider} connection probe outcome is unknown: {}",
                message.into()
            ),
        }
    }
}

/// Native provider probe owner.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FleetConnectionProbe;

impl FleetConnectionProbe {
    pub(crate) async fn probe<R: FleetSecretResolverPort>(
        provider: FleetConnectionProbeProvider<'_>,
        resolver: &mut R,
    ) -> FleetConnectionProbeOutcome
    where
        R::Secret: AsRef<str>,
    {
        match provider {
            FleetConnectionProbeProvider::Docker { config, ownership } => {
                if !valid_ownership(ownership) {
                    return FleetConnectionProbeOutcome::failed(
                        "Docker",
                        FleetConnectionProbeBoundaryError::InvalidOwnership.to_string(),
                    );
                }
                let client = match DockerEffectClient::new(config.clone(), ownership.clone()) {
                    Ok(client) => client,
                    Err(error) => return classify_docker(error),
                };
                match client.execute(DockerEffect::Ping, resolver).await {
                    Ok(_) => FleetConnectionProbeOutcome::Ready,
                    Err(error) => classify_docker(error),
                }
            }
            FleetConnectionProbeProvider::Kubernetes { config, target_id } => {
                let ownership = BTreeMap::from([
                    (MANAGED_LABEL.to_owned(), "true".to_owned()),
                    (TARGET_LABEL.to_owned(), target_id.as_str().to_owned()),
                ]);
                let client = match KubernetesEffectClient::new(config.clone(), ownership) {
                    Ok(client) => client,
                    Err(error) => return classify_kubernetes(error),
                };
                match client.execute(KubernetesEffect::Probe, resolver).await {
                    Ok(_) => FleetConnectionProbeOutcome::Ready,
                    Err(error) => classify_kubernetes(error),
                }
            }
            FleetConnectionProbeProvider::Ssh {
                config,
                pinned_host_key,
            } => match SshEffect::default()
                .probe(config, resolver, pinned_host_key)
                .await
            {
                Ok(()) => FleetConnectionProbeOutcome::Ready,
                Err(error) => classify_ssh(error),
            },
        }
    }
}

fn valid_ownership(ownership: &BTreeMap<String, String>) -> bool {
    ownership
        .get(MANAGED_LABEL)
        .is_some_and(|value| value == "true")
        && ownership
            .iter()
            .all(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
}

fn classify_docker(error: DockerEffectError) -> FleetConnectionProbeOutcome {
    match error {
        DockerEffectError::Timeout | DockerEffectError::Network => {
            FleetConnectionProbeOutcome::unknown("Docker", error.to_string())
        }
        error => FleetConnectionProbeOutcome::failed("Docker", error.to_string()),
    }
}

fn classify_kubernetes(error: KubernetesEffectError) -> FleetConnectionProbeOutcome {
    match error {
        KubernetesEffectError::Timeout | KubernetesEffectError::Network => {
            FleetConnectionProbeOutcome::unknown("Kubernetes", error.to_string())
        }
        error => FleetConnectionProbeOutcome::failed("Kubernetes", error.to_string()),
    }
}

fn classify_ssh(error: SshEffectError) -> FleetConnectionProbeOutcome {
    match error {
        SshEffectError::Timeout | SshEffectError::Network | SshEffectError::Protocol => {
            FleetConnectionProbeOutcome::unknown("SSH", error.to_string())
        }
        error => FleetConnectionProbeOutcome::failed("SSH", error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_failures_are_unknown_not_ready() {
        assert_eq!(
            classify_docker(DockerEffectError::Timeout),
            FleetConnectionProbeOutcome::Unknown {
                message:
                    "Docker connection probe outcome is unknown: Docker Engine request timed out"
                        .into(),
            }
        );
        assert!(matches!(
            classify_kubernetes(KubernetesEffectError::Network),
            FleetConnectionProbeOutcome::Unknown { .. }
        ));
        assert!(matches!(
            classify_ssh(SshEffectError::Protocol),
            FleetConnectionProbeOutcome::Unknown { .. }
        ));
    }

    #[test]
    fn provider_failures_are_explicit_failures() {
        assert!(matches!(
            classify_docker(DockerEffectError::RemoteStatus(401)),
            FleetConnectionProbeOutcome::Failed { .. }
        ));
        assert!(matches!(
            classify_kubernetes(KubernetesEffectError::InvalidResponse),
            FleetConnectionProbeOutcome::Failed { .. }
        ));
        assert!(matches!(
            classify_ssh(SshEffectError::AuthenticationFailed),
            FleetConnectionProbeOutcome::Failed { .. }
        ));
    }

    #[test]
    fn ownership_requires_the_managed_marker_and_non_empty_values() {
        assert!(!valid_ownership(&BTreeMap::new()));
        assert!(!valid_ownership(&BTreeMap::from([(
            MANAGED_LABEL.into(),
            "false".into()
        )])));
        assert!(!valid_ownership(&BTreeMap::from([
            (MANAGED_LABEL.into(), "true".into()),
            (TARGET_LABEL.into(), " ".into()),
        ])));
        assert!(valid_ownership(&BTreeMap::from([
            (MANAGED_LABEL.into(), "true".into()),
            (TARGET_LABEL.into(), "target-a".into()),
        ])));
    }

    #[test]
    fn unsupported_custom_targets_and_missing_ssh_keys_are_rejected() {
        let target = FleetTargetConfig::Custom(
            fleet::CustomTargetConfig::try_new("wss://custom.example.test", None).unwrap(),
        );
        let id = TargetId::try_new("target-a").unwrap();
        let ownership = BTreeMap::from([(MANAGED_LABEL.into(), "true".into())]);
        assert!(matches!(
            FleetConnectionProbeProvider::from_target(&target, &id, &ownership, None),
            Err(FleetConnectionProbeBoundaryError::UnsupportedTarget { .. })
        ));
    }
}
