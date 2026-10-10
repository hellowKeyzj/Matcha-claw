use std::sync::Arc;

use channels::{ports::ChannelOps, trace::ChannelTraceSpan};
use foundation::process::supervision::{CommandReceipt, SupervisorPhase};
use runtime_directory::OwnedRuntimeFuture;
use zeroize::Zeroizing;

use crate::driver::OpenClawDriver;
use crate::driver::lifecycle::prepare_openclaw_lifecycle;
use crate::surfaces::channels::gateway::config::{
    channel_trace, current_channel_trace, with_channel_trace,
};

impl OpenClawDriver {
    pub(crate) async fn connect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> crate::surfaces::channels::gateway::control::ChannelControlEffect {
        self.gateway
            .lock()
            .await
            .connect_channel_account(channel, account)
            .await
    }

    pub(crate) async fn disconnect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> crate::surfaces::channels::gateway::control::ChannelControlEffect {
        self.gateway
            .lock()
            .await
            .disconnect_channel_account(channel, account)
            .await
    }

    pub(crate) async fn channel_runtime_stop(
        &self,
        channel: String,
        account: Option<String>,
    ) -> crate::port::ChannelRuntimeEffect {
        self.gateway
            .lock()
            .await
            .channel_runtime(crate::port::ChannelRuntimeAction::Stop, channel, account)
            .await
    }

    pub(crate) async fn web_login_start(
        &self,
        channel: String,
        input: crate::port::WebLoginStart,
    ) -> crate::port::WebLoginStartEffect {
        self.gateway
            .lock()
            .await
            .web_login_start(channel, input)
            .await
    }

    pub(crate) async fn weixin_login_start(
        &self,
        input: crate::port::WebLoginStart,
    ) -> crate::port::WebLoginStartEffect {
        if self
            .plugins()
            .prepare_configured_channel_plugin(
                crate::surfaces::channels::gateway::weixin_login::OPENCLAW_WEIXIN_CHANNEL,
                &self.openclaw_dir,
            )
            .is_err()
        {
            return crate::port::WebLoginStartEffect::Unknown;
        }
        self.weixin_login.start(input).await
    }

    pub(crate) async fn weixin_login_cancel(&self, account_id: Option<String>) {
        self.weixin_login.cancel(account_id).await;
    }

    pub(crate) async fn logout_channel(
        &self,
        channel: String,
        account: Option<String>,
    ) -> crate::port::ChannelRuntimeEffect {
        self.gateway
            .lock()
            .await
            .channel_runtime(crate::port::ChannelRuntimeAction::Logout, channel, account)
            .await
    }

    pub(crate) async fn list_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
    ) -> crate::surfaces::channels::gateway::pairing::ChannelPairingEffect {
        let effect = self
            .gateway
            .lock()
            .await
            .list_channel_pairing(channel.clone(), account.clone())
            .await;
        if !matches!(
            effect,
            crate::surfaces::channels::gateway::pairing::ChannelPairingEffect::UnknownPairingChannel
        ) {
            return effect;
        }
        if self.activate_channel_plugin(&channel).await.is_err() {
            return crate::surfaces::channels::gateway::pairing::ChannelPairingEffect::OutcomeUnknown;
        }
        self.gateway
            .lock()
            .await
            .list_channel_pairing(channel, account)
            .await
    }

    pub(crate) async fn approve_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> crate::surfaces::channels::gateway::pairing::ChannelPairingApprovalEffect {
        self.gateway
            .lock()
            .await
            .approve_channel_pairing(channel, account, code)
            .await
    }

    pub(crate) async fn observe_channel_accounts(
        &self,
    ) -> crate::surfaces::channels::gateway::status::ChannelStatusEffect {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .observe_channel_accounts(runtime_running)
            .await
    }

    pub(crate) async fn observe_channel_snapshot(
        &self,
    ) -> crate::surfaces::channels::gateway::status::ChannelSnapshotEffect {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .observe_channel_snapshot(runtime_running)
            .await
    }

    pub(crate) async fn channel_catalog(&self) -> crate::port::ChannelCatalogEffect {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .channel_catalog(runtime_running)
            .await
    }

    pub(crate) async fn channel_configure_form(
        &self,
        channel: String,
    ) -> crate::port::ChannelConfigSchemaEffect {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .channel_configure_form(channel, runtime_running)
            .await
    }

    pub(crate) async fn read_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> crate::port::ChannelConfigReadEffect {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .read_channel_config(channel, account_id, runtime_running)
            .await
    }

    pub(crate) async fn validate_channel_credentials(
        &self,
        channel: String,
        account: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> crate::surfaces::channels::gateway::credentials::ChannelCredentialsEffect {
        self.gateway
            .lock()
            .await
            .validate_channel_credentials(channel, account, config)
            .await
    }

    fn prepare_channel_plugin(
        &self,
        channel: &str,
    ) -> Result<crate::native_config::plugins::ChannelPluginPreparation, ()> {
        self.plugins()
            .prepare_configured_channel_plugin(channel, &self.openclaw_dir)
            .map_err(|_| ())
    }

    async fn activate_channel_plugin(&self, channel: &str) -> Result<(), ()> {
        let preparation = self.prepare_channel_plugin(channel)?;
        if !preparation.is_external_managed_channel {
            return Err(());
        }
        if self.supervisor_handle().snapshot().phase() != SupervisorPhase::Running {
            return Err(());
        }
        self.refresh_plugin_inventory().await?;
        self.restart_gateway_after_openclaw_receipt().await
    }

    async fn refresh_plugin_inventory(&self) -> Result<(), ()> {
        let mut span = ChannelTraceSpan::begin("host.composition.plugins_refresh");
        let outcome = self.gateway.lock().await.refresh_plugins().await;
        span.finish(match outcome {
            crate::port::PluginRefreshOutcome::RestartRequired => "restart_required",
            crate::port::PluginRefreshOutcome::Rejected => "rejected",
            crate::port::PluginRefreshOutcome::Unknown => "unknown",
        });
        match outcome {
            crate::port::PluginRefreshOutcome::RestartRequired => Ok(()),
            crate::port::PluginRefreshOutcome::Rejected
            | crate::port::PluginRefreshOutcome::Unknown => Err(()),
        }
    }

    async fn restart_gateway_after_openclaw_receipt(&self) -> Result<(), ()> {
        let _reservation = self.try_reserve_lifecycle().ok_or(())?;
        let supervisor = self.supervisor_handle();
        if supervisor.snapshot().phase() != SupervisorPhase::Running {
            channel_trace(
                "host.composition.restart_receipt",
                "outcome=skipped reason=gateway_restart_required state=not_running",
            );
            return Ok(());
        }
        let mut restart_prepare_span = ChannelTraceSpan::begin("host.composition.restart_prepare");
        if prepare_openclaw_lifecycle(
            &supervisor,
            self.gateway_port,
            self.plugins(),
            Arc::clone(&self.diagnostic_reporter),
        )
        .await
        .is_err()
        {
            restart_prepare_span.finish("failed");
            return Err(());
        }
        restart_prepare_span.finish("prepared");
        drop(restart_prepare_span);
        let mut restart_span = ChannelTraceSpan::begin("host.composition.restart_receipt");
        let receipt = supervisor.restart().await;
        restart_span.finish(match &receipt {
            CommandReceipt::Accepted(_) => "accepted",
            CommandReceipt::Shared(_) => "shared",
            CommandReceipt::AlreadySatisfied => "already_satisfied",
            CommandReceipt::Busy => "busy",
            CommandReceipt::Rejected(_) => "rejected",
            CommandReceipt::ShuttingDown => "shutting_down",
        });
        match receipt {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                let mut completion_span =
                    ChannelTraceSpan::begin("host.composition.restart_completion");
                if completion.wait().await.is_err() {
                    completion_span.finish("failed");
                    return Err(());
                }
                completion_span.finish("completed");
                Ok(())
            }
            CommandReceipt::AlreadySatisfied => Ok(()),
            CommandReceipt::Busy | CommandReceipt::Rejected(_) | CommandReceipt::ShuttingDown => {
                Err(())
            }
        }
    }

    pub(crate) async fn channel_configure(
        &self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        patch: serde_json::Map<String, serde_json::Value>,
        login_completed: bool,
    ) -> crate::port::ChannelConfigMutationOutcome {
        let mut span = ChannelTraceSpan::begin("host.composition.configure");
        let mut preparation_span = ChannelTraceSpan::begin("host.composition.plugin_prepare");
        let preparation = match self.prepare_channel_plugin(&channel) {
            Ok(preparation) => preparation,
            Err(_) => {
                preparation_span.finish("failed");
                span.finish("preparation_failed");
                return crate::port::ChannelConfigMutationOutcome::Unknown;
            }
        };
        preparation_span.finish("prepared");
        drop(preparation_span);
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        channel_trace(
            "host.composition.config_save",
            if runtime_running {
                "mode=running"
            } else {
                "mode=offline"
            },
        );
        let mut save_span = ChannelTraceSpan::begin("host.composition.config_save");
        let outcome = self
            .gateway
            .lock()
            .await
            .configure_channel(
                channel,
                account_id,
                patch,
                preparation.plugin_id.clone(),
                agent_id,
                runtime_running,
                login_completed,
            )
            .await;
        let outcome_class = match outcome {
            crate::port::ChannelConfigMutationOutcome::Confirmed => "confirmed",
            crate::port::ChannelConfigMutationOutcome::Noop => "noop",
            crate::port::ChannelConfigMutationOutcome::RestartRequired => "restart_required",
            crate::port::ChannelConfigMutationOutcome::Rejected => "rejected",
            crate::port::ChannelConfigMutationOutcome::Unknown => "unknown",
        };
        save_span.finish(outcome_class);
        drop(save_span);
        if matches!(
            outcome,
            crate::port::ChannelConfigMutationOutcome::Confirmed
                | crate::port::ChannelConfigMutationOutcome::Noop
        ) && runtime_running
            && preparation.is_external_managed_channel
            && preparation.artifact_changed
        {
            if self.refresh_plugin_inventory().await.is_err()
                || self.restart_gateway_after_openclaw_receipt().await.is_err()
            {
                span.finish("restart_unavailable");
                return crate::port::ChannelConfigMutationOutcome::Unknown;
            }
        } else if matches!(
            outcome,
            crate::port::ChannelConfigMutationOutcome::RestartRequired
        ) {
            if self.restart_gateway_after_openclaw_receipt().await.is_err() {
                span.finish("restart_unavailable");
                return crate::port::ChannelConfigMutationOutcome::Unknown;
            }
        } else {
            channel_trace(
                "host.composition.restart_receipt",
                match outcome {
                    crate::port::ChannelConfigMutationOutcome::Confirmed
                    | crate::port::ChannelConfigMutationOutcome::Noop => {
                        "outcome=skipped reason=native_reload"
                    }
                    crate::port::ChannelConfigMutationOutcome::RestartRequired => {
                        "outcome=skipped reason=gateway_restart_required state=not_running"
                    }
                    crate::port::ChannelConfigMutationOutcome::Rejected
                    | crate::port::ChannelConfigMutationOutcome::Unknown => {
                        "outcome=skipped reason=config_unconfirmed"
                    }
                },
            );
        }
        span.finish(outcome_class);
        outcome
    }

    pub(crate) async fn delete_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> crate::port::DeleteConfigOutcome {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .delete_channel_config(channel, account_id, runtime_running)
            .await
    }
}

impl ChannelOps for OpenClawDriver {
    fn control_channel_account<'a>(
        &'a self,
        action: channels::control::ChannelControlAction,
        channel: String,
        account: String,
    ) -> channels::ports::ChannelFuture<'a, channels::control::ChannelControlOutcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.control");
            let effect = match action {
                channels::control::ChannelControlAction::Connect => {
                    self.connect_channel_account(channel, account).await
                }
                channels::control::ChannelControlAction::Disconnect => {
                    self.disconnect_channel_account(channel, account).await
                }
            };
            let outcome = crate::surfaces::channels::project_control_effect(effect);
            span.finish(match outcome {
                channels::control::ChannelControlOutcome::Confirmed => "confirmed",
                channels::control::ChannelControlOutcome::Rejected => "rejected",
                channels::control::ChannelControlOutcome::OutcomeUnknown => "unknown",
            });
            outcome
        })
    }

    fn start_channel_login<'a>(
        &'a self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
    ) -> channels::ports::ChannelFuture<'a, channels::login::Outcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.login_start");
            let input = crate::port::WebLoginStart {
                force,
                timeout_ms,
                verbose: false,
                account_id,
            };
            let effect = if channel
                == crate::surfaces::channels::gateway::weixin_login::OPENCLAW_WEIXIN_CHANNEL
            {
                self.weixin_login_start(input).await
            } else {
                self.web_login_start(channel.clone(), input).await
            };
            let outcome = crate::surfaces::channels::project_login_start_effect(channel, effect);
            span.finish(outcome.trace_outcome());
            outcome
        })
    }

    fn wait_channel_login_owned(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<channels::login::Outcome> {
        let gateway = Arc::clone(&self.gateway);
        let weixin_login = self.weixin_login.clone();
        let trace_id = current_channel_trace();
        Box::pin(with_channel_trace(trace_id, async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.login_wait");
            let input = crate::port::WebLoginWait {
                timeout_ms,
                account_id,
                session_key,
                current_qr_data_url,
            };
            let effect = if channel
                == crate::surfaces::channels::gateway::weixin_login::OPENCLAW_WEIXIN_CHANNEL
            {
                weixin_login.wait(input, cancellation.clone()).await
            } else {
                gateway
                    .lock()
                    .await
                    .web_login_wait_with_cancellation(channel.clone(), input, cancellation.clone())
                    .await
            };
            let outcome = if cancellation.is_cancelled() {
                channels::login::Outcome::Cancelled
            } else {
                crate::surfaces::channels::project_login_wait_effect(channel, effect)
            };
            span.finish(outcome.trace_outcome());
            outcome
        }))
    }

    fn stop_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> channels::ports::ChannelFuture<'a, channels::login::Outcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.stop_login");
            let outcome = if channel
                == crate::surfaces::channels::gateway::weixin_login::OPENCLAW_WEIXIN_CHANNEL
            {
                self.weixin_login_cancel(account_id).await;
                channels::login::Outcome::Cancelled
            } else {
                crate::surfaces::channels::project_stop_login_effect(
                    self.channel_runtime_stop(channel, account_id).await,
                )
            };
            span.finish(outcome.trace_outcome());
            outcome
        })
    }

    fn logout_channel<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> channels::ports::ChannelFuture<'a, channels::login::Outcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.logout");
            let outcome = crate::surfaces::channels::project_logout_effect(
                self.logout_channel(channel, account_id).await,
            );
            span.finish(outcome.trace_outcome());
            outcome
        })
    }

    fn list_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
    ) -> channels::ports::ChannelFuture<'a, channels::status::ChannelPairingOutcome> {
        Box::pin(async move {
            crate::surfaces::channels::project_pairing_effect(
                self.list_channel_pairing(channel, account).await,
            )
        })
    }

    fn approve_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
    ) -> channels::ports::ChannelFuture<'a, channels::status::ChannelPairingApprovalOutcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.pairing_approve");
            let outcome = crate::surfaces::channels::project_pairing_approval_effect(
                self.approve_channel_pairing(channel, account, code).await,
            );
            span.finish(outcome.code());
            outcome
        })
    }

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> channels::ports::ChannelFuture<
        'a,
        Result<channels::status::ChannelStatusOutcome, channels::status::ChannelStatusFailure>,
    > {
        Box::pin(async move {
            crate::surfaces::channels::project_status_effect(self.observe_channel_accounts().await)
        })
    }

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> channels::ports::ChannelFuture<
        'a,
        Result<channels::status::ChannelSnapshotOutcome, channels::status::ChannelStatusFailure>,
    > {
        Box::pin(async move {
            crate::surfaces::channels::project_snapshot_effect(
                self.observe_channel_snapshot().await,
            )
        })
    }

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> channels::ports::ChannelFuture<'a, channels::config_read::Outcome> {
        Box::pin(async move {
            crate::surfaces::channels::project_config_read_effect(
                self.read_channel_config(channel, account_id).await,
            )
        })
    }

    fn validate_channel_credentials<'a>(
        &'a self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> channels::ports::ChannelFuture<'a, channels::credentials::Outcome> {
        Box::pin(async move {
            crate::surfaces::channels::project_credentials_effect(
                self.validate_channel_credentials(channel, None, config)
                    .await,
            )
        })
    }

    fn channel_catalog<'a>(
        &'a self,
    ) -> channels::ports::ChannelFuture<'a, channels::catalog::ChannelCatalogOutcome> {
        Box::pin(async move {
            crate::surfaces::channels::project_catalog_effect(self.channel_catalog().await)
        })
    }

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> channels::ports::ChannelFuture<'a, channels::catalog::ChannelConfigureFormOutcome> {
        Box::pin(async move {
            crate::surfaces::channels::project_form_effect(
                self.channel_configure_form(channel).await,
            )
        })
    }

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> channels::ports::ChannelFuture<'a, channels::catalog::ChannelConfigureOutcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.configure");
            let patch = match channels::catalog::parse_patch(values) {
                Ok(patch) => patch,
                Err(()) => return channels::catalog::ChannelConfigureOutcome::TargetRejected,
            };
            let outcome = crate::surfaces::channels::project_config_mutation_effect(
                self.channel_configure(channel, account_id, agent_id, patch, false)
                    .await,
            );
            span.finish(match outcome {
                channels::catalog::ChannelConfigureOutcome::Confirmed => "confirmed",
                channels::catalog::ChannelConfigureOutcome::TargetRejected => "rejected",
                channels::catalog::ChannelConfigureOutcome::Unknown => "unknown",
            });
            outcome
        })
    }

    fn finalize_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> channels::ports::ChannelFuture<'a, channels::catalog::ChannelConfigureOutcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.configure");
            let patch = match channels::catalog::parse_patch(values) {
                Ok(patch) => patch,
                Err(()) => return channels::catalog::ChannelConfigureOutcome::TargetRejected,
            };
            let outcome = crate::surfaces::channels::project_config_mutation_effect(
                self.channel_configure(channel, account_id, agent_id, patch, true)
                    .await,
            );
            span.finish(match outcome {
                channels::catalog::ChannelConfigureOutcome::Confirmed => "confirmed",
                channels::catalog::ChannelConfigureOutcome::TargetRejected => "rejected",
                channels::catalog::ChannelConfigureOutcome::Unknown => "unknown",
            });
            outcome
        })
    }

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> channels::ports::ChannelFuture<'a, channels::delete::Outcome> {
        Box::pin(async move {
            let mut span = ChannelTraceSpan::begin("openclaw.channel.delete_config");
            let outcome = crate::surfaces::channels::project_delete_config_effect(
                self.delete_channel_config(channel, account_id).await,
            );
            span.finish(match outcome {
                channels::delete::Outcome::Confirmed => "confirmed",
                channels::delete::Outcome::TargetRejected => "rejected",
                channels::delete::Outcome::Unknown => "unknown",
            });
            outcome
        })
    }
}
