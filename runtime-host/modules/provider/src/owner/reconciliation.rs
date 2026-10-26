use std::{collections::BTreeSet, time::Duration};

use tokio::time::{Instant, timeout_at};

use crate::{
    ProviderAccount, ProviderAccountExecution, ProviderAccountExecutionStatus, ProviderAccountId,
    ProviderAppliedStatus, ProviderCallDiagnostic, ProviderCallDiagnosticReason, ProviderCascade,
    ProviderConfigWriteEffect, ProviderNativeConfigurationCommand,
    ProviderNativeConfigurationDiagnostic, ProviderNativeConfigurationEffect,
    ProviderNativeConfigurationEvidence, ProviderObservedStatus, ProviderPrivateProjectionCommand,
    ProviderPrivateProjectionEffect, ProviderRuntimeReport, ProviderSessionEndpoint,
    call::ProviderCall,
};

use super::actor::{ProviderOwner, ProviderSnapshot};

impl ProviderOwner {
    pub(super) async fn reconcile(
        &mut self,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<ProviderAccountId>,
        auth_state_refresh_required: bool,
        account_failures: Vec<ProviderAccountExecution>,
        call: &mut Option<ProviderCall>,
    ) -> ProviderNativeConfigurationEffect {
        let deadline = Instant::now() + Duration::from_secs(30);
        let reloaded = self.cascade.reload().is_ok();
        self.update_snapshot();
        let accounts = self.cascade.accounts();
        let identity_ops = self.runtime_directory.provider_runtime_identity_ops(
            &ProviderSessionEndpoint::OpenClawLocal.runtime_endpoint(),
        );
        let (applied, account_failures) = if reloaded {
            self.accounts
                .apply_private_profiles_for_provider_config(
                    identity_ops,
                    accounts,
                    required_auth_accounts,
                    account_failures,
                    deadline,
                )
                .await
        } else {
            (false, account_failures)
        };
        if let (Some(call), Some(diagnostic)) = (
            call.as_mut(),
            account_failures
                .iter()
                .find_map(|failure| failure.diagnostic),
        ) {
            call.diagnostic(
                diagnostic
                    .reason
                    .unwrap_or(ProviderCallDiagnosticReason::Unknown),
                diagnostic.private_resolver_code,
            );
        }

        let provider_ops = self.runtime_directory.provider_config_ops();
        let mut effects = Vec::new();
        for ops in &provider_ops {
            let endpoint = ops.endpoint();
            let failures = if endpoint == ProviderSessionEndpoint::OpenClawLocal {
                account_failures.as_slice()
            } else {
                &[]
            };
            let effect = if !reloaded {
                unavailable_effect(endpoint, failures, "config-snapshot-unavailable")
            } else if endpoint == ProviderSessionEndpoint::OpenClawLocal && identity_ops.is_none() {
                unavailable_effect(endpoint, failures, "private-profile-invalid-provider-key")
            } else if Instant::now() >= deadline {
                unavailable_effect(endpoint, failures, "private-profile-deadline")
            } else {
                let command = ProviderNativeConfigurationCommand {
                    resolver: self.accounts.private_resolver(),
                    accounts,
                    account_failures: failures,
                    models: self.cascade.catalog(),
                    routing: self.cascade.routing(),
                    retired,
                    required_auth_accounts,
                    auth_state_refresh_required: auth_state_refresh_required || applied,
                    now_millis: now_millis(),
                };
                match timeout_at(
                    deadline,
                    ops.reconcile_provider_native_configuration(command),
                )
                .await
                {
                    Ok(effect) => effect,
                    Err(_) => unavailable_effect(endpoint, failures, "private-profile-deadline"),
                }
            };
            let effect = if effect.reports().is_empty() {
                effect.with_report(endpoint, failures.to_vec())
            } else {
                effect
            };
            self.publish_reports(effect.reports());
            effects.push(effect);
        }
        // A disappeared port is not evidence that its previously applied configuration is current.
        for report in &self.snapshot.load_full().reports {
            if !provider_ops
                .iter()
                .any(|ops| ops.endpoint() == report.endpoint)
            {
                let effect =
                    unavailable_effect(report.endpoint, &[], "provider-projection-not-sent");
                self.publish_reports(effect.reports());
                effects.push(effect);
            }
        }
        if Instant::now() >= deadline {
            if let Some(call) = call {
                call.diagnostic(ProviderCallDiagnosticReason::PrivateProfileDeadline, None);
            }
            eprintln!(
                "[startup-trace] source=provider-owner phase=reconcile detail=budget-exhausted budget_ms=30000"
            );
        }
        effects
            .into_iter()
            .reduce(ProviderNativeConfigurationEffect::merge)
            .unwrap_or(ProviderNativeConfigurationEffect::Unavailable)
    }

    pub(super) async fn prepare_private_projection(
        &mut self,
        endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> ProviderPrivateProjectionEffect {
        let Some(peer) = [
            ProviderSessionEndpoint::OpenClawLocal,
            ProviderSessionEndpoint::MatchaAgentLocal,
        ]
        .into_iter()
        .find(|peer| peer.runtime_endpoint() == *endpoint) else {
            return ProviderPrivateProjectionEffect::unknown(
                "provider-private-projection-unavailable",
                "Provider private projection is unavailable",
            );
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        let reloaded = self.cascade.reload().is_ok();
        self.update_snapshot();
        let mut failures = Vec::new();
        if reloaded && peer == ProviderSessionEndpoint::OpenClawLocal {
            let required = self
                .cascade
                .routing()
                .map(crate::provider_routing_account_ids)
                .unwrap_or_default();
            let identity_ops = self
                .runtime_directory
                .provider_runtime_identity_ops(endpoint);
            (_, failures) = self
                .accounts
                .apply_private_profiles_for_provider_config(
                    identity_ops,
                    self.cascade.accounts(),
                    &required,
                    failures,
                    deadline,
                )
                .await;
        }
        let mut effect = if !reloaded {
            ProviderPrivateProjectionEffect::unknown(
                "config-snapshot-unavailable",
                "Provider cascade is unavailable",
            )
        } else if Instant::now() >= deadline {
            ProviderPrivateProjectionEffect::unknown(
                "private-profile-deadline",
                "Provider projection budget exhausted",
            )
        } else if let Some(ops) = self
            .runtime_directory
            .provider_private_projection_ops(endpoint)
        {
            timeout_at(
                deadline,
                ops.prepare_private_projection(ProviderPrivateProjectionCommand {
                    resolver: self.accounts.private_resolver(),
                    accounts: self.cascade.accounts(),
                    account_failures: &failures,
                    models: self.cascade.catalog(),
                    routing: self.cascade.routing(),
                    now_millis: now_millis(),
                }),
            )
            .await
            .unwrap_or_else(|_| {
                ProviderPrivateProjectionEffect::unknown(
                    "private-profile-deadline",
                    "Provider projection budget exhausted",
                )
            })
        } else {
            ProviderPrivateProjectionEffect::unknown(
                "provider-private-projection-unavailable",
                "Provider private projection is unavailable",
            )
        };
        if effect.reports.is_empty() {
            let diagnostic = match &effect.providers {
                ProviderConfigWriteEffect::Unknown(diagnostic) => Some(
                    ProviderCallDiagnostic::from_native_reason(diagnostic.reason()),
                ),
                _ => None,
            };
            effect.reports.push(ProviderRuntimeReport {
                endpoint: peer,
                changed: matches!(effect.providers, ProviderConfigWriteEffect::Written),
                applied: ProviderAppliedStatus::Unknown,
                observed: ProviderObservedStatus::Unavailable,
                diagnostic,
                accounts: failures,
            });
        }
        self.publish_reports(&effect.reports);
        effect
    }
}

pub(super) fn current_reports(
    previous: &ProviderSnapshot,
    cascade: &ProviderCascade,
    incoming: &[ProviderRuntimeReport],
) -> Vec<ProviderRuntimeReport> {
    let accounts = cascade.accounts();
    let inventory_changed = previous.accounts != accounts;
    let configuration_changed =
        previous.catalog != *cascade.catalog() || previous.routing.as_ref() != cascade.routing();
    let mut reports = previous.reports.clone();
    for report in &mut reports {
        let invalidate_peer = configuration_changed
            || (inventory_changed && report.endpoint == ProviderSessionEndpoint::OpenClawLocal);
        report.accounts.retain_mut(|observed| {
            let Some(account) = accounts.iter().find(|account| {
                observed.account_id == account.id().as_str()
                    && observed.account_revision == account.revision().get()
            }) else {
                return false;
            };
            if !previous.accounts.iter().any(|previous| previous == account) {
                return false;
            }
            if invalidate_peer && !account_auth_failure(observed) {
                observed.execution = ProviderAccountExecutionStatus::Unknown;
                observed.diagnostic = None;
            }
            true
        });
        if inventory_changed || configuration_changed {
            report.changed = false;
            report.applied = ProviderAppliedStatus::Unknown;
            report.observed = ProviderObservedStatus::Unavailable;
            report.diagnostic = None;
        }
    }
    // Reports contain only this call's observations, not an account health rescan.
    for incoming in incoming {
        let mut report = incoming.clone();
        let current = reports
            .iter_mut()
            .find(|current| current.endpoint == report.endpoint);
        report.accounts = current
            .as_ref()
            .map(|current| current.accounts.clone())
            .unwrap_or_default();
        for observed in &incoming.accounts {
            if !accounts.iter().any(|account| {
                observed.account_id == account.id().as_str()
                    && observed.account_revision == account.revision().get()
            }) {
                continue;
            }
            if let Some(previous) = report.accounts.iter_mut().find(|previous| {
                observed.account_id == previous.account_id
                    && observed.account_revision == previous.account_revision
            }) {
                *previous = observed.clone();
            } else {
                report.accounts.push(observed.clone());
            }
        }
        if let Some(current) = current {
            *current = report;
        } else {
            reports.push(report);
        }
    }
    for report in &mut reports {
        let mut incomplete = false;
        let mut blocked = false;
        for observed in &report.accounts {
            if !accounts.iter().any(|account| {
                account.id().as_str() == observed.account_id && account.configuration().enabled()
            }) {
                continue;
            }
            match observed.execution {
                ProviderAccountExecutionStatus::Ready => {}
                ProviderAccountExecutionStatus::Unknown => incomplete = true,
                ProviderAccountExecutionStatus::Blocked
                | ProviderAccountExecutionStatus::Unsupported => {
                    incomplete = true;
                    blocked = true;
                }
            }
        }
        if incomplete {
            report.applied = ProviderAppliedStatus::Unknown;
            if blocked {
                report.observed = ProviderObservedStatus::Mismatch;
            } else if report.observed == ProviderObservedStatus::Matches {
                report.observed = ProviderObservedStatus::Unavailable;
            }
            report.diagnostic.get_or_insert(ProviderCallDiagnostic {
                reason: Some(ProviderCallDiagnosticReason::ProviderProjectionPartial),
                private_resolver_code: None,
            });
        }
    }
    reports
}

fn account_auth_failure(observed: &ProviderAccountExecution) -> bool {
    let Some(diagnostic) = observed.diagnostic else {
        return false;
    };
    match observed.execution {
        ProviderAccountExecutionStatus::Blocked => {
            matches!(
                diagnostic.reason,
                Some(
                    ProviderCallDiagnosticReason::PrivateProfileCredentialMissing
                        | ProviderCallDiagnosticReason::ProviderCredentialUnavailable
                )
            ) || diagnostic.private_resolver_code
                == Some(crate::ProviderCallPrivateResolverCode::CredentialMissing)
        }
        ProviderAccountExecutionStatus::Unsupported => {
            diagnostic.reason == Some(ProviderCallDiagnosticReason::ProviderAuthUnsupported)
        }
        _ => false,
    }
}

fn unavailable_effect(
    endpoint: ProviderSessionEndpoint,
    failures: &[ProviderAccountExecution],
    reason: &'static str,
) -> ProviderNativeConfigurationEffect {
    ProviderNativeConfigurationEffect::Evidence(
        ProviderNativeConfigurationEvidence::with_diagnostic(
            false,
            ProviderAppliedStatus::Unknown,
            ProviderObservedStatus::Unavailable,
            ProviderNativeConfigurationDiagnostic::new(
                "reconcile",
                reason,
                "providers",
                None,
                None,
                None,
            ),
        )
        .with_report(endpoint, failures.to_vec()),
    )
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(u64::MAX)
}
