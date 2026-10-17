use std::collections::{BTreeMap, BTreeSet};

use connectors::{ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort};
use provider_module::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountKind, ProviderApiProtocol,
    ProviderAppliedStatus, ProviderConfigWriteEffect, ProviderNativeConfigurationCommand,
    ProviderNativeConfigurationDiagnostic, ProviderNativeConfigurationEffect,
    ProviderNativeConfigurationEvidence, ProviderObservedStatus, ProviderPrivateProjectionCommand,
    ProviderPrivateProjectionEffect, ProviderProjectionBuildDiagnostic, ProviderRestartPreparation,
    Resolver,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    account_provider_id,
    projection::{self, Projection, ProjectionFailure, ProjectionFailureKind, ProjectionReceipt},
};
use crate::client::Client;

pub(super) async fn reconcile(
    client: &Client,
    command: ProviderNativeConfigurationCommand<'_>,
) -> ProviderNativeConfigurationEffect {
    match apply(client, command.accounts, command.resolver).await {
        Ok((receipt, unsupported)) => {
            ProviderNativeConfigurationEffect::Evidence(if unsupported > 0 {
                ProviderNativeConfigurationEvidence::with_diagnostic(
                    receipt.changed,
                    ProviderAppliedStatus::Unknown,
                    ProviderObservedStatus::Mismatch,
                    diagnostic(
                        "provider-projection-partial",
                        format!(
                            "{unsupported} enabled chat accounts do not have supported Matcha execution authentication/protocol"
                        ),
                    ),
                )
            } else if !receipt.cleanup.blocked_provider_ids.is_empty() {
                ProviderNativeConfigurationEvidence::with_diagnostic(
                    receipt.changed,
                    ProviderAppliedStatus::Unknown,
                    ProviderObservedStatus::Mismatch,
                    diagnostic(
                        "provider-cleanup-partial",
                        "Desired providers were projected; referenced retired providers were retained",
                    ),
                )
            } else if receipt.requires_restart {
                ProviderNativeConfigurationEvidence::with_diagnostic(
                    receipt.changed,
                    ProviderAppliedStatus::Unknown,
                    ProviderObservedStatus::Matches,
                    diagnostic(
                        "provider-restart-required",
                        "Provider configuration is confirmed for future CLI instances; active sessions require restart",
                    ),
                )
            } else {
                ProviderNativeConfigurationEvidence::new(
                    receipt.changed,
                    ProviderAppliedStatus::Confirmed,
                    ProviderObservedStatus::Matches,
                )
            })
        }
        Err(failure) => ProviderNativeConfigurationEffect::Evidence(
            ProviderNativeConfigurationEvidence::with_diagnostic(
                false,
                ProviderAppliedStatus::Unknown,
                if matches!(
                    failure.kind(),
                    ProjectionFailureKind::InvalidBinding | ProjectionFailureKind::InvalidReadback
                ) {
                    ProviderObservedStatus::Mismatch
                } else {
                    ProviderObservedStatus::Unavailable
                },
                diagnostic(failure_reason(&failure), failure.to_string()),
            ),
        ),
    }
}

pub(super) async fn prepare(
    client: &Client,
    command: ProviderPrivateProjectionCommand<'_>,
) -> ProviderPrivateProjectionEffect {
    match apply(client, command.accounts, command.resolver).await {
        Ok((receipt, unsupported)) => ProviderPrivateProjectionEffect {
            providers: if unsupported > 0 {
                ProviderConfigWriteEffect::Unknown(ProviderProjectionBuildDiagnostic::new(
                    "provider-projection-partial",
                    "providers",
                    format!(
                        "{unsupported} enabled chat accounts do not have supported Matcha execution authentication/protocol"
                    ),
                ))
            } else if !receipt.cleanup.blocked_provider_ids.is_empty() {
                ProviderConfigWriteEffect::Unknown(ProviderProjectionBuildDiagnostic::new(
                    "provider-cleanup-partial",
                    "providers",
                    "Desired providers were projected; referenced retired providers were retained",
                ))
            } else if receipt.changed {
                ProviderConfigWriteEffect::Written
            } else {
                ProviderConfigWriteEffect::Unchanged
            },
            restart: if receipt.requires_restart {
                ProviderRestartPreparation::Required
            } else {
                ProviderRestartPreparation::NotRequired
            },
        },
        Err(failure) => ProviderPrivateProjectionEffect {
            providers: ProviderConfigWriteEffect::Unknown(ProviderProjectionBuildDiagnostic::new(
                failure_reason(&failure),
                "providers",
                failure.to_string(),
            )),
            restart: ProviderRestartPreparation::Unknown,
        },
    }
}

async fn apply(
    client: &Client,
    accounts: &[ProviderAccount],
    resolver: &Resolver,
) -> Result<(ProjectionReceipt, usize), ProjectionFailure> {
    let mut unsupported = 0;
    let mut desired_ids = BTreeSet::new();
    let mut projection = Projection {
        providers: BTreeMap::new(),
        sources: BTreeMap::new(),
        retired: Vec::new(),
    };
    for account in accounts.iter().filter(|account| {
        account.configuration().enabled()
            && account.configuration().kind() == ProviderAccountKind::Chat
    }) {
        desired_ids.insert(account_provider_id(account.id().as_str()));
        let Some(protocol) = provider_module::provider_execution_protocol(account) else {
            unsupported += 1;
            continue;
        };
        let (kind, target) = match protocol {
            ProviderApiProtocol::AnthropicMessages => ("firstParty", "ANTHROPIC_API_KEY"),
            ProviderApiProtocol::GoogleGenerativeAi => ("gemini", "GEMINI_API_KEY"),
            ProviderApiProtocol::OpenAiCompletions => ("openai", "OPENAI_API_KEY"),
            ProviderApiProtocol::OpenAiResponses => ("openaiResponses", "OPENAI_API_KEY"),
        };
        let configuration = account.configuration();
        // Match the existing Host Matcha session resolver's supported authentication, rather
        // than silently treating OpenClaw OAuth profiles or CLI user stores as API keys.
        if !matches!(
            configuration.auth_mode(),
            ProviderAccountAuthMode::ApiKey | ProviderAccountAuthMode::Local
        ) {
            unsupported += 1;
            continue;
        }
        let id = account_provider_id(account.id().as_str());
        let mut env = BTreeMap::new();
        if configuration.auth_mode() == ProviderAccountAuthMode::ApiKey {
            let source = format!(
                "MATCHA_PROVIDER_{}",
                id.trim_start_matches("host-account-").to_ascii_uppercase()
            );
            let credential = configuration.credential().ok_or(ProjectionFailure::new(
                ProjectionFailureKind::CredentialMissing,
            ))?;
            let reference = ConnectorSecretRef::try_new(credential.as_str())
                .map_err(|_| ProjectionFailure::new(ProjectionFailureKind::InvalidBinding))?;
            let value = match resolver.resolve(&reference).await.map_err(|error| {
                ProjectionFailure::caused(ProjectionFailureKind::CredentialUnavailable, error)
            })? {
                ConnectorSecretResolution::Resolved { value, .. } => {
                    let mut secret = None;
                    value.with_private_bytes(|bytes| {
                        secret = std::str::from_utf8(bytes).ok().map(str::to_owned);
                    });
                    secret
                        .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
                        .ok_or(ProjectionFailure::new(
                            ProjectionFailureKind::CredentialUnavailable,
                        ))?
                }
                ConnectorSecretResolution::NotFound { .. } => {
                    return Err(ProjectionFailure::new(
                        ProjectionFailureKind::CredentialMissing,
                    ));
                }
                ConnectorSecretResolution::Unavailable { .. } => {
                    return Err(ProjectionFailure::new(
                        ProjectionFailureKind::CredentialUnavailable,
                    ));
                }
            };
            env.insert(target, source.clone());
            projection.sources.insert(source, value);
        }
        let endpoint = provider_module::provider_execution_endpoint(account)
            .map_err(|_| ProjectionFailure::new(ProjectionFailureKind::InvalidBinding))?;
        projection.providers.insert(
            id,
            projection::provider_config(kind, Some(endpoint.as_str()), env),
        );
    }
    let response = client
        .call("providers.list", json!({}))
        .await
        .map_err(projection::transport_failure)?;
    #[derive(Deserialize)]
    struct List {
        providers: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        id: String,
    }
    let current: List = serde_json::from_value(response).map_err(|error| {
        ProjectionFailure::caused(ProjectionFailureKind::InvalidReadback, error)
    })?;
    projection.retired = current
        .providers
        .into_iter()
        .map(|provider| provider.id)
        .filter(|id| id.starts_with("host-account-") && !desired_ids.contains(id))
        .collect();
    projection::project(client, projection)
        .await
        .map(|receipt| (receipt, unsupported))
}

fn diagnostic(
    reason: &'static str,
    detail: impl Into<String>,
) -> ProviderNativeConfigurationDiagnostic {
    ProviderNativeConfigurationDiagnostic::new(
        "private-projection",
        reason,
        "providers",
        Some("providers.project".into()),
        Some("providers".into()),
        Some(detail.into()),
    )
}

fn failure_reason(failure: &ProjectionFailure) -> &'static str {
    match failure.kind() {
        ProjectionFailureKind::InvalidBinding => "provider-account-configuration-invalid",
        ProjectionFailureKind::CredentialMissing => "provider-credential-unavailable",
        ProjectionFailureKind::CredentialUnavailable => "private-resolver-unavailable",
        ProjectionFailureKind::NotSent => "provider-projection-not-sent",
        ProjectionFailureKind::Remote {
            kind: projection::ProjectionRemoteKind::CommitUnknown,
            ..
        }
        | ProjectionFailureKind::Unknown => "provider-projection-outcome-unknown",
        ProjectionFailureKind::Remote {
            kind: projection::ProjectionRemoteKind::Conflict,
            ..
        } => "provider-cleanup-blocked",
        ProjectionFailureKind::Remote { .. } => "provider-projection-rejected",
        ProjectionFailureKind::InvalidReadback => "config-readback-mismatch",
    }
}
