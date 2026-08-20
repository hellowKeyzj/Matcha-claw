use std::sync::Arc;

use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{
    channel_catalog::{
        ChannelCatalog, ChannelCatalogEntry, ChannelCatalogOutcome, ChannelConfigureField,
        ChannelConfigureFieldKind, ChannelConfigureForm, ChannelConfigureFormOutcome,
        ChannelConfigureOutcome,
    },
    channel_control::{ChannelControlAction, ChannelControlOutcome},
    channel_delete,
    channel_login::{LoginProgress, LoginProgressStatus, Outcome as ChannelLoginOutcome},
    channel_status::{
        ChannelAccountStatus, ChannelConnection, ChannelPairingApprovalOutcome,
        ChannelPairingOutcome, ChannelPairingRequest, ChannelPairingRequestMeta,
        ChannelPairingRequestStatus, ChannelSnapshotOutcome, ChannelStatusFailure,
        ChannelStatusOutcome,
    },
};

use super::openclaw::OpenClawInstance;

pub(crate) struct OpenClawChannelProvider<'a> {
    runtime: &'a OpenClawInstance,
}

impl<'a> OpenClawChannelProvider<'a> {
    pub(crate) fn openclaw(runtime: &'a OpenClawInstance) -> Self {
        Self { runtime }
    }
}

impl OpenClawChannelProvider<'_> {
    fn map_login_progress(
        channel: String,
        progress: openclaw::port::LoginProgress,
    ) -> LoginProgress {
        let status = match progress.status() {
            openclaw::port::LoginProgressStatus::Connected => LoginProgressStatus::Connected,
            openclaw::port::LoginProgressStatus::Qr => LoginProgressStatus::Qr,
            openclaw::port::LoginProgressStatus::Pending => LoginProgressStatus::Pending,
            openclaw::port::LoginProgressStatus::Rejected => LoginProgressStatus::Rejected,
            openclaw::port::LoginProgressStatus::Unknown => LoginProgressStatus::Unknown,
        };
        LoginProgress::new(
            channel,
            progress.account_id().map(str::to_owned),
            progress.session_key().map(str::to_owned),
            status,
            progress.qr_data_url().map(str::to_owned),
        )
    }

    fn map_catalog_effect(effect: openclaw::port::ChannelCatalogEffect) -> ChannelCatalogOutcome {
        match effect {
            openclaw::port::ChannelCatalogEffect::Catalog(catalog) => {
                ChannelCatalogOutcome::Catalog(ChannelCatalog {
                    entries: catalog
                        .entries()
                        .iter()
                        .map(|entry| ChannelCatalogEntry {
                            id: entry.id().to_owned(),
                            label: entry.label().to_owned(),
                            detail_label: entry.detail_label().to_owned(),
                            system_image: entry.system_image().map(str::to_owned),
                            configured: entry.configured(),
                        })
                        .collect(),
                })
            }
            openclaw::port::ChannelCatalogEffect::Rejected => ChannelCatalogOutcome::Rejected,
            openclaw::port::ChannelCatalogEffect::OutcomeUnknown => ChannelCatalogOutcome::Unknown,
        }
    }

    fn map_form_effect(
        effect: openclaw::port::ChannelConfigSchemaEffect,
    ) -> ChannelConfigureFormOutcome {
        match effect {
            openclaw::port::ChannelConfigSchemaEffect::Form(form) => {
                ChannelConfigureFormOutcome::Form(ChannelConfigureForm {
                    fields: form
                        .fields()
                        .iter()
                        .map(|field| ChannelConfigureField {
                            key: field.key().to_owned(),
                            label: field.label().to_owned(),
                            description: field.description().map(str::to_owned),
                            kind: match field.kind() {
                                openclaw::port::ChannelConfigureFieldKind::Text => {
                                    ChannelConfigureFieldKind::Text
                                }
                                openclaw::port::ChannelConfigureFieldKind::Password => {
                                    ChannelConfigureFieldKind::Password
                                }
                                openclaw::port::ChannelConfigureFieldKind::Boolean => {
                                    ChannelConfigureFieldKind::Boolean
                                }
                                openclaw::port::ChannelConfigureFieldKind::Number => {
                                    ChannelConfigureFieldKind::Number
                                }
                                openclaw::port::ChannelConfigureFieldKind::Select => {
                                    ChannelConfigureFieldKind::Select
                                }
                            },
                            required: field.required(),
                            options: field.options().map(|options| options.to_vec()),
                        })
                        .collect(),
                })
            }
            openclaw::port::ChannelConfigSchemaEffect::Rejected => {
                ChannelConfigureFormOutcome::TargetRejected
            }
            openclaw::port::ChannelConfigSchemaEffect::OutcomeUnknown => {
                ChannelConfigureFormOutcome::Unknown
            }
        }
    }

    pub(crate) async fn control(
        &self,
        action: ChannelControlAction,
        channel: String,
        account: String,
    ) -> ChannelControlOutcome {
        let effect = match action {
            ChannelControlAction::Connect => {
                self.runtime.connect_channel_account(channel, account).await
            }
            ChannelControlAction::Disconnect => {
                self.runtime
                    .disconnect_channel_account(channel, account)
                    .await
            }
        };
        match effect {
            openclaw::operations::channel_control::ChannelControlEffect::Confirmed => {
                ChannelControlOutcome::Confirmed
            }
            openclaw::operations::channel_control::ChannelControlEffect::Rejected => {
                ChannelControlOutcome::Rejected
            }
            openclaw::operations::channel_control::ChannelControlEffect::OutcomeUnknown => {
                ChannelControlOutcome::OutcomeUnknown
            }
        }
    }

    pub(crate) async fn stop_login(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelLoginOutcome {
        Self::map_stop_login_effect(self.runtime.channel_runtime_stop(channel, account_id).await)
    }

    fn map_stop_login_effect(effect: openclaw::port::ChannelRuntimeEffect) -> ChannelLoginOutcome {
        match effect {
            openclaw::port::ChannelRuntimeEffect::Confirmed(_) => ChannelLoginOutcome::Cancelled,
            openclaw::port::ChannelRuntimeEffect::Rejected => ChannelLoginOutcome::Rejected,
            openclaw::port::ChannelRuntimeEffect::Unknown => ChannelLoginOutcome::Unknown,
        }
    }

    pub(crate) async fn login_start(
        &self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
    ) -> ChannelLoginOutcome {
        let effect = self
            .runtime
            .web_login_start(
                channel.clone(),
                openclaw::port::WebLoginStart {
                    force,
                    timeout_ms,
                    verbose: false,
                    account_id,
                },
            )
            .await;
        match effect {
            openclaw::port::WebLoginStartEffect::Progress(progress) => {
                ChannelLoginOutcome::Progress(Self::map_login_progress(channel, progress))
            }
            openclaw::port::WebLoginStartEffect::Rejected => ChannelLoginOutcome::Rejected,
            openclaw::port::WebLoginStartEffect::Unsupported => ChannelLoginOutcome::Unsupported,
            openclaw::port::WebLoginStartEffect::Unknown => ChannelLoginOutcome::Unknown,
        }
    }

    pub(crate) async fn login_wait(
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        qr: Option<String>,
        cancellation: CancellationToken,
        gateway: Arc<tokio::sync::Mutex<openclaw::port::OpenClawGateway>>,
    ) -> ChannelLoginOutcome {
        let effect = gateway
            .lock()
            .await
            .web_login_wait_with_cancellation(
                channel.clone(),
                openclaw::port::WebLoginWait {
                    timeout_ms,
                    account_id,
                    session_key,
                    current_qr_data_url: qr,
                },
                cancellation.clone(),
            )
            .await;
        if cancellation.is_cancelled() {
            return ChannelLoginOutcome::Cancelled;
        }
        Self::map_login_wait_effect(channel, effect)
    }

    pub(crate) fn map_login_wait_effect(
        channel: String,
        effect: openclaw::port::WebLoginWaitEffect,
    ) -> ChannelLoginOutcome {
        match effect {
            openclaw::port::WebLoginWaitEffect::Progress(progress) => {
                ChannelLoginOutcome::Progress(Self::map_login_progress(channel, progress))
            }
            openclaw::port::WebLoginWaitEffect::Cancelled => ChannelLoginOutcome::Cancelled,
            openclaw::port::WebLoginWaitEffect::Rejected => ChannelLoginOutcome::Rejected,
            openclaw::port::WebLoginWaitEffect::Unsupported => ChannelLoginOutcome::Unsupported,
            openclaw::port::WebLoginWaitEffect::Unknown => ChannelLoginOutcome::Unknown,
        }
    }

    pub(crate) async fn logout(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelLoginOutcome {
        match self.runtime.logout_channel(channel, account_id).await {
            openclaw::port::ChannelRuntimeEffect::Confirmed(_) => ChannelLoginOutcome::Confirmed,
            openclaw::port::ChannelRuntimeEffect::Rejected => ChannelLoginOutcome::Rejected,
            openclaw::port::ChannelRuntimeEffect::Unknown => ChannelLoginOutcome::Unknown,
        }
    }

    pub(crate) async fn pairing_list(
        &self,
        channel: String,
        account: Option<String>,
    ) -> ChannelPairingOutcome {
        match self.runtime.list_channel_pairing(channel, account).await {
            openclaw::operations::channel_pairing::ChannelPairingEffect::Listed(requests) => {
                ChannelPairingOutcome::Listed(
                    requests
                        .into_iter()
                        .map(|request| ChannelPairingRequest {
                            id: request.id,
                            created_at: request.created_at,
                            last_seen_at: request.last_seen_at,
                            meta: request
                                .meta
                                .and_then(|meta| meta.get("accountId").cloned())
                                .map(ChannelPairingRequestMeta::new),
                            status: match request.status {
                                openclaw::operations::channel_pairing::ChannelPairingRequestStatus::Pending => {
                                    ChannelPairingRequestStatus::Pending
                                }
                                openclaw::operations::channel_pairing::ChannelPairingRequestStatus::Unknown => {
                                    ChannelPairingRequestStatus::Unknown
                                }
                            },
                        })
                        .collect(),
                )
            }
            openclaw::operations::channel_pairing::ChannelPairingEffect::Rejected => {
                ChannelPairingOutcome::Rejected
            }
            openclaw::operations::channel_pairing::ChannelPairingEffect::OutcomeUnknown => {
                ChannelPairingOutcome::OutcomeUnknown
            }
        }
    }

    pub(crate) async fn pairing_approve(
        &self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> ChannelPairingApprovalOutcome {
        match self
            .runtime
            .approve_channel_pairing(channel, account, code)
            .await
        {
            openclaw::operations::channel_pairing::ChannelPairingApprovalEffect::Confirmed => {
                ChannelPairingApprovalOutcome::Confirmed
            }
            openclaw::operations::channel_pairing::ChannelPairingApprovalEffect::TargetRejected => {
                ChannelPairingApprovalOutcome::TargetRejected
            }
            openclaw::operations::channel_pairing::ChannelPairingApprovalEffect::OutcomeUnknown => {
                ChannelPairingApprovalOutcome::Unknown
            }
        }
    }

    pub(crate) async fn status(&self) -> Result<ChannelStatusOutcome, ChannelStatusFailure> {
        match self.runtime.observe_channel_accounts().await {
            openclaw::operations::channel_status::ChannelStatusEffect::Observed(receipt) => {
                Ok(ChannelStatusOutcome::new(
                    receipt
                        .observations()
                        .iter()
                        .map(|observation| {
                            ChannelAccountStatus::new(
                                observation.channel().to_owned(),
                                observation.account_id().to_owned(),
                                match observation.connection() {
                                    openclaw::operations::channel_status::ChannelConnection::Connected => {
                                        ChannelConnection::Connected
                                    }
                                    openclaw::operations::channel_status::ChannelConnection::Disconnected => {
                                        ChannelConnection::Disconnected
                                    }
                                    openclaw::operations::channel_status::ChannelConnection::Unknown => {
                                        ChannelConnection::Unknown
                                    }
                                },
                            )
                        })
                        .collect(),
                ))
            }
            openclaw::operations::channel_status::ChannelStatusEffect::RuntimeRejected => {
                Err(ChannelStatusFailure::Rejected)
            }
            openclaw::operations::channel_status::ChannelStatusEffect::OutcomeUnknown => {
                Err(ChannelStatusFailure::Unavailable)
            }
        }
    }

    pub(crate) async fn snapshot(&self) -> Result<ChannelSnapshotOutcome, ChannelStatusFailure> {
        match self.runtime.observe_channel_snapshot().await {
            openclaw::operations::channel_status::ChannelSnapshotEffect::Observed(snapshot) => {
                Ok(ChannelSnapshotOutcome::new(
                    snapshot.ts,
                    snapshot.channel_order,
                    snapshot
                        .channels
                        .into_iter()
                        .map(|(channel, summary)| {
                            (
                                channel,
                                crate::channel_status::ChannelSummarySnapshot::new(
                                    summary.configured,
                                    summary.running,
                                    summary.error,
                                    summary.last_error,
                                ),
                            )
                        })
                        .collect(),
                    snapshot
                        .channel_accounts
                        .into_iter()
                        .map(|(channel, accounts)| {
                            (
                                channel,
                                accounts
                                    .into_iter()
                                    .map(|account| {
                                        crate::channel_status::ChannelAccountSnapshot::new(
                                            account.account_id,
                                            account.configured,
                                            account.connected,
                                            account.running,
                                            account.linked,
                                            account.last_error,
                                            account.name,
                                            account.last_connected_at,
                                            account.last_inbound_at,
                                            account.last_outbound_at,
                                            account.last_probe_at,
                                            account.probe.map(|probe| {
                                                crate::channel_status::ChannelProbeSnapshot::new(
                                                    probe.ok,
                                                )
                                            }),
                                        )
                                    })
                                    .collect(),
                            )
                        })
                        .collect(),
                    snapshot.channel_default_account_id,
                ))
            }
            openclaw::operations::channel_status::ChannelSnapshotEffect::RuntimeRejected => {
                Err(ChannelStatusFailure::Rejected)
            }
            openclaw::operations::channel_status::ChannelSnapshotEffect::OutcomeUnknown => {
                Err(ChannelStatusFailure::Unavailable)
            }
        }
    }

    pub(crate) async fn catalog(&self) -> ChannelCatalogOutcome {
        Self::map_catalog_effect(self.runtime.channel_catalog().await)
    }

    pub(crate) async fn configure_form(&self, channel: String) -> ChannelConfigureFormOutcome {
        Self::map_form_effect(self.runtime.channel_configure_form(channel).await)
    }

    pub(crate) async fn read_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> crate::channel_config_read::Outcome {
        match self.runtime.read_channel_config(channel, account_id).await {
            openclaw::port::ChannelConfigReadEffect::Values(projection) => {
                match crate::channel_config_read::Projection::from_source(
                    projection.values().clone(),
                ) {
                    Ok(projection) => crate::channel_config_read::Outcome::Values(projection),
                    Err(()) => crate::channel_config_read::Outcome::Unknown,
                }
            }
            openclaw::port::ChannelConfigReadEffect::Rejected => {
                crate::channel_config_read::Outcome::TargetRejected
            }
            openclaw::port::ChannelConfigReadEffect::OutcomeUnknown => {
                crate::channel_config_read::Outcome::Unknown
            }
        }
    }

    pub(crate) async fn validate_channel_credentials(
        &self,
        channel: String,
        config: Zeroizing<Vec<u8>>,
    ) -> crate::channel_credentials::Outcome {
        match self
            .runtime
            .validate_channel_credentials(channel, None, config)
            .await
        {
            openclaw::operations::channel_credentials::ChannelCredentialsEffect::Validated(
                validation,
            ) => crate::channel_credentials::Outcome::Validated(
                crate::channel_credentials::Validation {
                    success: true,
                    valid: validation.valid,
                    errors: validation.errors,
                    warnings: validation.warnings,
                    details: validation.details,
                },
            ),
            openclaw::operations::channel_credentials::ChannelCredentialsEffect::Rejected => {
                crate::channel_credentials::Outcome::TargetRejected
            }
            openclaw::operations::channel_credentials::ChannelCredentialsEffect::OutcomeUnknown => {
                crate::channel_credentials::Outcome::Unknown
            }
        }
    }

    pub(crate) async fn configure(
        &self,
        channel: String,
        account: String,
        values: Zeroizing<Vec<u8>>,
    ) -> ChannelConfigureOutcome {
        let patch = match crate::channel_catalog::parse_patch(values) {
            Ok(patch) => patch,
            Err(()) => return ChannelConfigureOutcome::TargetRejected,
        };
        match self
            .runtime
            .channel_configure(channel, account, patch)
            .await
        {
            openclaw::port::ChannelConfigMutationOutcome::Confirmed => {
                ChannelConfigureOutcome::Confirmed
            }
            openclaw::port::ChannelConfigMutationOutcome::Rejected => {
                ChannelConfigureOutcome::TargetRejected
            }
            openclaw::port::ChannelConfigMutationOutcome::Unknown => {
                ChannelConfigureOutcome::Unknown
            }
        }
    }

    pub(crate) async fn delete_config(
        &self,
        channel: String,
        account: String,
    ) -> channel_delete::Outcome {
        match self.runtime.delete_channel_config(channel, account).await {
            openclaw::port::DeleteConfigOutcome::Confirmed => channel_delete::Outcome::Confirmed,
            openclaw::port::DeleteConfigOutcome::Rejected => {
                channel_delete::Outcome::TargetRejected
            }
            openclaw::port::DeleteConfigOutcome::Unknown => channel_delete::Outcome::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_login_preserves_native_rejection_and_unknown_outcomes() {
        assert_eq!(
            OpenClawChannelProvider::map_stop_login_effect(
                openclaw::port::ChannelRuntimeEffect::Rejected,
            ),
            ChannelLoginOutcome::Rejected,
        );
        assert_eq!(
            OpenClawChannelProvider::map_stop_login_effect(
                openclaw::port::ChannelRuntimeEffect::Unknown,
            ),
            ChannelLoginOutcome::Unknown,
        );
    }
}
