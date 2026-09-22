use channels::{
    catalog::{
        ChannelCatalog, ChannelCatalogEntry, ChannelCatalogOutcome, ChannelConfigureField,
        ChannelConfigureFieldKind, ChannelConfigureForm, ChannelConfigureFormOutcome,
        ChannelConfigureOutcome,
    },
    control::ChannelControlOutcome,
    credentials, delete as channel_delete,
    login::{LoginProgress, LoginProgressStatus, Outcome as ChannelLoginOutcome},
    status::{
        ChannelAccountStatus, ChannelConnection, ChannelPairingApprovalOutcome,
        ChannelPairingOutcome, ChannelPairingRequest, ChannelPairingRequestMeta,
        ChannelPairingRequestStatus, ChannelSnapshotOutcome, ChannelStatusFailure,
        ChannelStatusOutcome,
    },
};

use crate::{
    operations::{channel_control, channel_credentials, channel_pairing, channel_status},
    port,
};

const PUBLIC_CHANNEL_STATUS_ERROR: &str = "Channel status reported an error";

pub fn project_control_effect(
    effect: channel_control::ChannelControlEffect,
) -> ChannelControlOutcome {
    match effect {
        channel_control::ChannelControlEffect::Confirmed => ChannelControlOutcome::Confirmed,
        channel_control::ChannelControlEffect::Rejected => ChannelControlOutcome::Rejected,
        channel_control::ChannelControlEffect::OutcomeUnknown => {
            ChannelControlOutcome::OutcomeUnknown
        }
    }
}

pub fn project_stop_login_effect(effect: port::ChannelRuntimeEffect) -> ChannelLoginOutcome {
    match effect {
        port::ChannelRuntimeEffect::Confirmed(_) => ChannelLoginOutcome::Cancelled,
        port::ChannelRuntimeEffect::Rejected => ChannelLoginOutcome::Rejected,
        port::ChannelRuntimeEffect::Unknown => ChannelLoginOutcome::Unknown,
    }
}

pub fn project_login_start_effect(
    channel: String,
    effect: port::WebLoginStartEffect,
) -> ChannelLoginOutcome {
    match effect {
        port::WebLoginStartEffect::Progress(progress) => {
            ChannelLoginOutcome::Progress(project_login_progress(channel, progress))
        }
        port::WebLoginStartEffect::Rejected => ChannelLoginOutcome::Rejected,
        port::WebLoginStartEffect::Unsupported => ChannelLoginOutcome::Unsupported,
        port::WebLoginStartEffect::Unknown => ChannelLoginOutcome::Unknown,
    }
}

pub fn project_login_wait_effect(
    channel: String,
    effect: port::WebLoginWaitEffect,
) -> ChannelLoginOutcome {
    match effect {
        port::WebLoginWaitEffect::Progress(progress) => {
            ChannelLoginOutcome::Progress(project_login_progress(channel, progress))
        }
        port::WebLoginWaitEffect::Cancelled => ChannelLoginOutcome::Cancelled,
        port::WebLoginWaitEffect::Rejected => ChannelLoginOutcome::Rejected,
        port::WebLoginWaitEffect::Unsupported => ChannelLoginOutcome::Unsupported,
        port::WebLoginWaitEffect::Unknown => ChannelLoginOutcome::Unknown,
    }
}

pub fn project_logout_effect(effect: port::ChannelRuntimeEffect) -> ChannelLoginOutcome {
    match effect {
        port::ChannelRuntimeEffect::Confirmed(_) => ChannelLoginOutcome::Confirmed,
        port::ChannelRuntimeEffect::Rejected => ChannelLoginOutcome::Rejected,
        port::ChannelRuntimeEffect::Unknown => ChannelLoginOutcome::Unknown,
    }
}

pub fn project_pairing_effect(
    effect: channel_pairing::ChannelPairingEffect,
) -> ChannelPairingOutcome {
    match effect {
        channel_pairing::ChannelPairingEffect::Listed(requests) => ChannelPairingOutcome::Listed(
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
                        channel_pairing::ChannelPairingRequestStatus::Pending => {
                            ChannelPairingRequestStatus::Pending
                        }
                        channel_pairing::ChannelPairingRequestStatus::Unknown => {
                            ChannelPairingRequestStatus::Unknown
                        }
                    },
                })
                .collect(),
        ),
        channel_pairing::ChannelPairingEffect::UnknownPairingChannel
        | channel_pairing::ChannelPairingEffect::Rejected => ChannelPairingOutcome::Rejected,
        channel_pairing::ChannelPairingEffect::OutcomeUnknown => {
            ChannelPairingOutcome::OutcomeUnknown
        }
    }
}

pub fn project_pairing_approval_effect(
    effect: channel_pairing::ChannelPairingApprovalEffect,
) -> ChannelPairingApprovalOutcome {
    match effect {
        channel_pairing::ChannelPairingApprovalEffect::Confirmed => {
            ChannelPairingApprovalOutcome::Confirmed
        }
        channel_pairing::ChannelPairingApprovalEffect::TargetRejected => {
            ChannelPairingApprovalOutcome::TargetRejected
        }
        channel_pairing::ChannelPairingApprovalEffect::OutcomeUnknown => {
            ChannelPairingApprovalOutcome::Unknown
        }
    }
}

pub fn project_status_effect(
    effect: channel_status::ChannelStatusEffect,
) -> Result<ChannelStatusOutcome, ChannelStatusFailure> {
    match effect {
        channel_status::ChannelStatusEffect::Observed(receipt) => Ok(ChannelStatusOutcome::new(
            receipt
                .observations()
                .iter()
                .map(|observation| {
                    ChannelAccountStatus::new(
                        observation.channel().to_owned(),
                        observation.account_id().to_owned(),
                        match observation.connection() {
                            channel_status::ChannelConnection::Connected => {
                                ChannelConnection::Connected
                            }
                            channel_status::ChannelConnection::Disconnected => {
                                ChannelConnection::Disconnected
                            }
                            channel_status::ChannelConnection::Unknown => {
                                ChannelConnection::Unknown
                            }
                        },
                    )
                })
                .collect(),
        )),
        channel_status::ChannelStatusEffect::RuntimeRejected => Err(ChannelStatusFailure::Rejected),
        channel_status::ChannelStatusEffect::OutcomeUnknown => {
            Err(ChannelStatusFailure::Unavailable)
        }
    }
}

pub fn project_snapshot_effect(
    effect: channel_status::ChannelSnapshotEffect,
) -> Result<ChannelSnapshotOutcome, ChannelStatusFailure> {
    match effect {
        channel_status::ChannelSnapshotEffect::Observed(snapshot) => {
            let status_error = if snapshot.warnings.is_empty() {
                None
            } else {
                Some(String::from(PUBLIC_CHANNEL_STATUS_ERROR))
            };
            Ok(ChannelSnapshotOutcome::new(
                snapshot.ts,
                !snapshot.partial,
                snapshot.partial,
                status_error.clone(),
                snapshot.channel_order,
                snapshot
                    .channels
                    .into_iter()
                    .map(|(channel, summary)| {
                        (
                            channel,
                            channels::status::ChannelSummarySnapshot::new(
                                summary.configured,
                                summary.running,
                                summary.error.or_else(|| status_error.clone()),
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
                                    channels::status::ChannelAccountSnapshot::new(
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
                                            channels::status::ChannelProbeSnapshot::new(probe.ok)
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
        channel_status::ChannelSnapshotEffect::RuntimeRejected => {
            Err(ChannelStatusFailure::Rejected)
        }
        channel_status::ChannelSnapshotEffect::OutcomeUnknown => {
            Err(ChannelStatusFailure::Unavailable)
        }
    }
}

pub fn project_catalog_effect(effect: port::ChannelCatalogEffect) -> ChannelCatalogOutcome {
    match effect {
        port::ChannelCatalogEffect::Catalog(catalog) => {
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
        port::ChannelCatalogEffect::Rejected => ChannelCatalogOutcome::Rejected,
        port::ChannelCatalogEffect::OutcomeUnknown => ChannelCatalogOutcome::Unknown,
    }
}

pub fn project_form_effect(effect: port::ChannelConfigSchemaEffect) -> ChannelConfigureFormOutcome {
    match effect {
        port::ChannelConfigSchemaEffect::Form(form) => {
            ChannelConfigureFormOutcome::Form(ChannelConfigureForm {
                fields: form
                    .fields()
                    .iter()
                    .map(|field| ChannelConfigureField {
                        key: field.key().to_owned(),
                        label: field.label().to_owned(),
                        description: field.description().map(str::to_owned),
                        kind: match field.kind() {
                            port::ChannelConfigureFieldKind::Text => {
                                ChannelConfigureFieldKind::Text
                            }
                            port::ChannelConfigureFieldKind::Password => {
                                ChannelConfigureFieldKind::Password
                            }
                            port::ChannelConfigureFieldKind::Boolean => {
                                ChannelConfigureFieldKind::Boolean
                            }
                            port::ChannelConfigureFieldKind::Number => {
                                ChannelConfigureFieldKind::Number
                            }
                            port::ChannelConfigureFieldKind::Select => {
                                ChannelConfigureFieldKind::Select
                            }
                        },
                        required: field.required(),
                        options: field.options().map(|options| options.to_vec()),
                    })
                    .collect(),
            })
        }
        port::ChannelConfigSchemaEffect::Rejected => ChannelConfigureFormOutcome::TargetRejected,
        port::ChannelConfigSchemaEffect::OutcomeUnknown => ChannelConfigureFormOutcome::Unknown,
    }
}

pub fn project_config_read_effect(
    effect: port::ChannelConfigReadEffect,
) -> channels::config_read::Outcome {
    match effect {
        port::ChannelConfigReadEffect::Values(projection) => {
            match channels::config_read::Projection::from_source(projection.values().clone()) {
                Ok(projection) => channels::config_read::Outcome::Values(projection),
                Err(()) => channels::config_read::Outcome::Unknown,
            }
        }
        port::ChannelConfigReadEffect::Rejected => channels::config_read::Outcome::TargetRejected,
        port::ChannelConfigReadEffect::OutcomeUnknown => channels::config_read::Outcome::Unknown,
    }
}

pub fn project_credentials_effect(
    effect: channel_credentials::ChannelCredentialsEffect,
) -> credentials::Outcome {
    match effect {
        channel_credentials::ChannelCredentialsEffect::Validated(validation) => {
            credentials::Outcome::Validated(credentials::Validation {
                success: true,
                valid: validation.valid,
                errors: validation.errors,
                warnings: validation.warnings,
                details: validation.details,
            })
        }
        channel_credentials::ChannelCredentialsEffect::Rejected => {
            credentials::Outcome::TargetRejected
        }
        channel_credentials::ChannelCredentialsEffect::OutcomeUnknown => {
            credentials::Outcome::Unknown
        }
    }
}

pub fn project_config_mutation_effect(
    effect: port::ChannelConfigMutationOutcome,
) -> ChannelConfigureOutcome {
    match effect {
        port::ChannelConfigMutationOutcome::Confirmed
        | port::ChannelConfigMutationOutcome::Noop
        | port::ChannelConfigMutationOutcome::RestartRequired => ChannelConfigureOutcome::Confirmed,
        port::ChannelConfigMutationOutcome::Rejected => ChannelConfigureOutcome::TargetRejected,
        port::ChannelConfigMutationOutcome::Unknown => ChannelConfigureOutcome::Unknown,
    }
}

pub fn project_delete_config_effect(effect: port::DeleteConfigOutcome) -> channel_delete::Outcome {
    match effect {
        port::DeleteConfigOutcome::Confirmed
        | port::DeleteConfigOutcome::Noop
        | port::DeleteConfigOutcome::RestartRequired => channel_delete::Outcome::Confirmed,
        port::DeleteConfigOutcome::Rejected => channel_delete::Outcome::TargetRejected,
        port::DeleteConfigOutcome::Unknown => channel_delete::Outcome::Unknown,
    }
}

fn project_login_progress(channel: String, progress: port::LoginProgress) -> LoginProgress {
    let status = match progress.status() {
        port::LoginProgressStatus::Connected => LoginProgressStatus::Connected,
        port::LoginProgressStatus::Qr => LoginProgressStatus::Qr,
        port::LoginProgressStatus::Pending => LoginProgressStatus::Pending,
        port::LoginProgressStatus::Rejected => LoginProgressStatus::Rejected,
        port::LoginProgressStatus::Unknown => LoginProgressStatus::Unknown,
    };
    LoginProgress::new(
        channel,
        progress.account_id().map(str::to_owned),
        progress.session_key().map(str::to_owned),
        status,
        progress.qr_data_url().map(str::to_owned),
    )
}
