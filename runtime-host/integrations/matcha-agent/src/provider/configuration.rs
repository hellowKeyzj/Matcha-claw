use std::collections::{BTreeMap, BTreeSet};

use connectors::{ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort};
use provider_module::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountExecution,
    ProviderAccountExecutionStatus, ProviderAccountKind, ProviderApiProtocol,
    ProviderAppliedStatus, ProviderCallDiagnostic, ProviderCallDiagnosticReason,
    ProviderCallPrivateResolverCode, ProviderConfigWriteEffect, ProviderNativeConfigurationCommand,
    ProviderNativeConfigurationDiagnostic, ProviderNativeConfigurationEffect,
    ProviderNativeConfigurationEvidence, ProviderObservedStatus, ProviderPrivateProjectionCommand,
    ProviderPrivateProjectionEffect, ProviderProjectionBuildDiagnostic, ProviderRestartPreparation,
    ProviderSessionEndpoint, Resolver,
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
    let (result, accounts) = apply(client, command.accounts, command.resolver).await;
    ProviderNativeConfigurationEffect::Evidence(evidence(&result, accounts))
}

pub(super) async fn prepare(
    client: &Client,
    command: ProviderPrivateProjectionCommand<'_>,
) -> ProviderPrivateProjectionEffect {
    let (result, accounts) = apply(client, command.accounts, command.resolver).await;
    let reports = evidence(&result, accounts).reports().to_vec();
    match result {
        Ok(receipt) => ProviderPrivateProjectionEffect {
            providers: if receipt.changed {
                ProviderConfigWriteEffect::Written
            } else {
                ProviderConfigWriteEffect::Unchanged
            },
            restart: if receipt.requires_restart {
                ProviderRestartPreparation::Required
            } else {
                ProviderRestartPreparation::NotRequired
            },
            reports,
        },
        Err(failure) => ProviderPrivateProjectionEffect {
            providers: ProviderConfigWriteEffect::Unknown(ProviderProjectionBuildDiagnostic::new(
                failure_reason(&failure),
                "providers",
                failure.to_string(),
            )),
            restart: ProviderRestartPreparation::Unknown,
            reports,
        },
    }
}

fn evidence(
    result: &Result<ProjectionReceipt, ProjectionFailure>,
    mut accounts: Vec<ProviderAccountExecution>,
) -> ProviderNativeConfigurationEvidence {
    let evidence = match result {
        Ok(receipt) => {
            let cleanup_blocked = !receipt.cleanup.blocked_provider_ids.is_empty();
            let mut observed = if cleanup_blocked {
                ProviderObservedStatus::Mismatch
            } else {
                ProviderObservedStatus::Matches
            };
            for account in &accounts {
                match account.execution {
                    ProviderAccountExecutionStatus::Blocked
                    | ProviderAccountExecutionStatus::Unsupported => {
                        observed = ProviderObservedStatus::Mismatch;
                    }
                    ProviderAccountExecutionStatus::Unknown
                        if observed == ProviderObservedStatus::Matches =>
                    {
                        observed = ProviderObservedStatus::Unavailable;
                    }
                    _ => {}
                }
            }
            let diagnostic = if cleanup_blocked {
                Some(diagnostic(
                    "provider-cleanup-partial",
                    "Desired providers were projected; referenced retired providers were retained",
                ))
            } else if receipt.requires_restart {
                Some(diagnostic(
                    "provider-restart-required",
                    "Provider configuration is confirmed for future CLI instances; active sessions require restart",
                ))
            } else if observed != ProviderObservedStatus::Matches {
                Some(diagnostic(
                    "provider-projection-partial",
                    "Eligible chat accounts were projected for future CLI instances; other accounts are not ready",
                ))
            } else {
                None
            };
            match diagnostic {
                Some(diagnostic) => ProviderNativeConfigurationEvidence::with_diagnostic(
                    receipt.changed,
                    ProviderAppliedStatus::Unknown,
                    observed,
                    diagnostic,
                ),
                None => ProviderNativeConfigurationEvidence::new(
                    receipt.changed,
                    ProviderAppliedStatus::Confirmed,
                    observed,
                ),
            }
        }
        Err(failure) => {
            for account in &mut accounts {
                if account.execution == ProviderAccountExecutionStatus::Ready {
                    account.execution = ProviderAccountExecutionStatus::Unknown;
                }
            }
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
                diagnostic(failure_reason(failure), failure.to_string()),
            )
        }
    };
    evidence.with_report(ProviderSessionEndpoint::MatchaAgentLocal, accounts)
}

async fn apply(
    client: &Client,
    accounts: &[ProviderAccount],
    resolver: &Resolver,
) -> (
    Result<ProjectionReceipt, ProjectionFailure>,
    Vec<ProviderAccountExecution>,
) {
    let mut executions = Vec::new();
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
        // Missing credentials do not retire an existing native identity or revoke its old source.
        let id = account_provider_id(account.id().as_str());
        desired_ids.insert(id.clone());
        let (execution, diagnostic) =
            match prepare_account(account, id, resolver, &mut projection).await {
                Ok(()) => (ProviderAccountExecutionStatus::Ready, None),
                Err((execution, diagnostic)) => (execution, Some(diagnostic)),
            };
        executions.push(ProviderAccountExecution {
            account_id: account.id().as_str().to_owned(),
            account_revision: account.revision().get(),
            execution,
            diagnostic,
        });
    }
    let result = async {
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
        projection::project(client, projection).await
    }
    .await;
    (result, executions)
}

async fn prepare_account(
    account: &ProviderAccount,
    id: String,
    resolver: &Resolver,
    projection: &mut Projection,
) -> Result<(), (ProviderAccountExecutionStatus, ProviderCallDiagnostic)> {
    use ProviderAccountExecutionStatus::{Blocked, Unknown, Unsupported};
    use ProviderCallDiagnosticReason::{
        PrivateResolverUnavailable, ProviderAccountConfigurationInvalid, ProviderAuthUnsupported,
        ProviderCredentialUnavailable,
    };
    use ProviderCallPrivateResolverCode::{CredentialInvalid, CredentialMissing};

    let failure = |execution, reason, private_resolver_code| {
        (
            execution,
            ProviderCallDiagnostic {
                reason: Some(reason),
                private_resolver_code,
            },
        )
    };
    let protocol = provider_module::provider_execution_protocol(account)
        .ok_or_else(|| failure(Unsupported, ProviderAccountConfigurationInvalid, None))?;
    let configuration = account.configuration();
    // OpenClaw OAuth profiles and CLI user stores are not Matcha API keys.
    if !matches!(
        configuration.auth_mode(),
        ProviderAccountAuthMode::ApiKey | ProviderAccountAuthMode::Local
    ) {
        return Err(failure(Unsupported, ProviderAuthUnsupported, None));
    }
    let endpoint = provider_module::provider_execution_endpoint(account)
        .map_err(|_| failure(Unknown, ProviderAccountConfigurationInvalid, None))?;
    let mut env = BTreeMap::new();
    if configuration.auth_mode() == ProviderAccountAuthMode::ApiKey {
        let credential = configuration.credential().ok_or_else(|| {
            failure(
                Blocked,
                ProviderCredentialUnavailable,
                Some(CredentialMissing),
            )
        })?;
        let reference = ConnectorSecretRef::try_new(credential.as_str())
            .map_err(|_| failure(Unknown, ProviderAccountConfigurationInvalid, None))?;
        let value = match resolver
            .resolve(&reference)
            .await
            .map_err(|_| failure(Unknown, PrivateResolverUnavailable, None))?
        {
            ConnectorSecretResolution::Resolved { value, .. } => {
                let mut secret = None;
                value.with_private_bytes(|bytes| {
                    secret = std::str::from_utf8(bytes).ok().map(str::to_owned);
                });
                secret
                    .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
                    .ok_or_else(|| {
                        failure(
                            Unknown,
                            ProviderCredentialUnavailable,
                            Some(CredentialInvalid),
                        )
                    })?
            }
            ConnectorSecretResolution::NotFound { .. } => {
                return Err(failure(
                    Blocked,
                    ProviderCredentialUnavailable,
                    Some(CredentialMissing),
                ));
            }
            ConnectorSecretResolution::Unavailable { .. } => {
                return Err(failure(Unknown, PrivateResolverUnavailable, None));
            }
        };
        let target = match protocol {
            ProviderApiProtocol::AnthropicMessages => "ANTHROPIC_API_KEY",
            ProviderApiProtocol::GoogleGenerativeAi => "GEMINI_API_KEY",
            ProviderApiProtocol::OpenAiCompletions | ProviderApiProtocol::OpenAiResponses => {
                "OPENAI_API_KEY"
            }
        };
        let source = format!(
            "MATCHA_PROVIDER_{}",
            id.trim_start_matches("host-account-").to_ascii_uppercase()
        );
        env.insert(target, source.clone());
        projection.sources.insert(source, value);
    }
    projection.providers.insert(
        id,
        projection::provider_config(
            super::native_protocol(protocol),
            Some(endpoint.as_str()),
            env,
        ),
    );
    Ok(())
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
