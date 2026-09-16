use super::super::owner::lifecycle::prepare_openclaw_lifecycle;
use super::*;

impl OpenClawInstance {
    pub(crate) async fn connect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> openclaw::operations::channel_control::ChannelControlEffect {
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
    ) -> openclaw::operations::channel_control::ChannelControlEffect {
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
    ) -> openclaw::port::ChannelRuntimeEffect {
        self.gateway
            .lock()
            .await
            .channel_runtime(openclaw::port::ChannelRuntimeAction::Stop, channel, account)
            .await
    }

    pub(crate) async fn web_login_start(
        &self,
        channel: String,
        input: openclaw::port::WebLoginStart,
    ) -> openclaw::port::WebLoginStartEffect {
        self.gateway
            .lock()
            .await
            .web_login_start(channel, input)
            .await
    }

    pub(crate) async fn weixin_login_start(
        &self,
        input: openclaw::port::WebLoginStart,
    ) -> openclaw::port::WebLoginStartEffect {
        if self
            .plugins()
            .prepare_configured_channel_plugin(
                openclaw::operations::weixin_login::OPENCLAW_WEIXIN_CHANNEL,
                &self.openclaw_dir,
            )
            .is_err()
        {
            return openclaw::port::WebLoginStartEffect::Unknown;
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
    ) -> openclaw::port::ChannelRuntimeEffect {
        self.gateway
            .lock()
            .await
            .channel_runtime(
                openclaw::port::ChannelRuntimeAction::Logout,
                channel,
                account,
            )
            .await
    }

    pub(crate) async fn list_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
    ) -> openclaw::operations::channel_pairing::ChannelPairingEffect {
        let effect = self
            .gateway
            .lock()
            .await
            .list_channel_pairing(channel.clone(), account.clone())
            .await;
        if !matches!(
            effect,
            openclaw::operations::channel_pairing::ChannelPairingEffect::UnknownPairingChannel
        ) {
            return effect;
        }
        if self.activate_channel_plugin(&channel).await.is_err() {
            return openclaw::operations::channel_pairing::ChannelPairingEffect::OutcomeUnknown;
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
    ) -> openclaw::operations::channel_pairing::ChannelPairingApprovalEffect {
        self.gateway
            .lock()
            .await
            .approve_channel_pairing(channel, account, code)
            .await
    }

    pub(crate) async fn observe_channel_accounts(
        &self,
    ) -> openclaw::operations::channel_status::ChannelStatusEffect {
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
    ) -> openclaw::operations::channel_status::ChannelSnapshotEffect {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .observe_channel_snapshot(runtime_running)
            .await
    }

    pub(crate) async fn channel_catalog(&self) -> openclaw::port::ChannelCatalogEffect {
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
    ) -> openclaw::port::ChannelConfigSchemaEffect {
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
    ) -> openclaw::port::ChannelConfigReadEffect {
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
    ) -> openclaw::operations::channel_credentials::ChannelCredentialsEffect {
        self.gateway
            .lock()
            .await
            .validate_channel_credentials(channel, account, config)
            .await
    }

    fn prepare_channel_plugin(
        &self,
        channel: &str,
    ) -> Result<openclaw::projection::plugins::ChannelPluginPreparation, ()> {
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
            openclaw::port::PluginRefreshOutcome::RestartRequired => "restart_required",
            openclaw::port::PluginRefreshOutcome::Rejected => "rejected",
            openclaw::port::PluginRefreshOutcome::Unknown => "unknown",
        });
        match outcome {
            openclaw::port::PluginRefreshOutcome::RestartRequired => Ok(()),
            openclaw::port::PluginRefreshOutcome::Rejected
            | openclaw::port::PluginRefreshOutcome::Unknown => Err(()),
        }
    }

    async fn restart_gateway_after_openclaw_receipt(&self) -> Result<(), ()> {
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
    ) -> openclaw::port::ChannelConfigMutationOutcome {
        let mut span = ChannelTraceSpan::begin("host.composition.configure");
        let mut preparation_span = ChannelTraceSpan::begin("host.composition.plugin_prepare");
        let preparation = match self.prepare_channel_plugin(&channel) {
            Ok(preparation) => preparation,
            Err(_) => {
                preparation_span.finish("failed");
                span.finish("preparation_failed");
                return openclaw::port::ChannelConfigMutationOutcome::Unknown;
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
            openclaw::port::ChannelConfigMutationOutcome::Confirmed => "confirmed",
            openclaw::port::ChannelConfigMutationOutcome::Noop => "noop",
            openclaw::port::ChannelConfigMutationOutcome::RestartRequired => "restart_required",
            openclaw::port::ChannelConfigMutationOutcome::Rejected => "rejected",
            openclaw::port::ChannelConfigMutationOutcome::Unknown => "unknown",
        };
        save_span.finish(outcome_class);
        drop(save_span);
        if matches!(
            outcome,
            openclaw::port::ChannelConfigMutationOutcome::Confirmed
                | openclaw::port::ChannelConfigMutationOutcome::Noop
        ) && runtime_running
            && preparation.is_external_managed_channel
            && preparation.artifact_changed
        {
            if self.refresh_plugin_inventory().await.is_err()
                || self.restart_gateway_after_openclaw_receipt().await.is_err()
            {
                span.finish("restart_unavailable");
                return openclaw::port::ChannelConfigMutationOutcome::Unknown;
            }
        } else if matches!(
            outcome,
            openclaw::port::ChannelConfigMutationOutcome::RestartRequired
        ) {
            if self.restart_gateway_after_openclaw_receipt().await.is_err() {
                span.finish("restart_unavailable");
                return openclaw::port::ChannelConfigMutationOutcome::Unknown;
            }
        } else {
            channel_trace(
                "host.composition.restart_receipt",
                match outcome {
                    openclaw::port::ChannelConfigMutationOutcome::Confirmed
                    | openclaw::port::ChannelConfigMutationOutcome::Noop => {
                        "outcome=skipped reason=native_reload"
                    }
                    openclaw::port::ChannelConfigMutationOutcome::RestartRequired => {
                        "outcome=skipped reason=gateway_restart_required state=not_running"
                    }
                    openclaw::port::ChannelConfigMutationOutcome::Rejected
                    | openclaw::port::ChannelConfigMutationOutcome::Unknown => {
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
    ) -> openclaw::port::DeleteConfigOutcome {
        let runtime_running =
            self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        self.gateway
            .lock()
            .await
            .delete_channel_config(channel, account_id, runtime_running)
            .await
    }
}

impl ChannelOps for OpenClawInstance {
    fn control_channel_account<'a>(
        &'a self,
        action: crate::channel::control::ChannelControlAction,
        channel: String,
        account: String,
    ) -> SessionFuture<'a, crate::channel::control::ChannelControlOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .control(action, channel, account)
                .await
        })
    }

    fn start_channel_login<'a>(
        &'a self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel::login::Outcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .login_start(channel, force, timeout_ms, account_id)
                .await
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
    ) -> OwnedRuntimeFuture<crate::channel::login::Outcome> {
        let gateway = Arc::clone(&self.gateway);
        let weixin_login = self.weixin_login.clone();
        let trace_id = current_channel_trace();
        Box::pin(with_channel_trace(trace_id, async move {
            super::super::adapters::channel::OpenClawChannelProvider::login_wait(
                channel,
                timeout_ms,
                account_id,
                session_key,
                current_qr_data_url,
                cancellation,
                gateway,
                weixin_login,
            )
            .await
        }))
    }

    fn stop_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel::login::Outcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .stop_login(channel, account_id)
                .await
        })
    }

    fn logout_channel<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel::login::Outcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .logout(channel, account_id)
                .await
        })
    }

    fn list_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
    ) -> SessionFuture<'a, crate::channel::status::ChannelPairingOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .pairing_list(channel, account)
                .await
        })
    }

    fn approve_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel::status::ChannelPairingApprovalOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .pairing_approve(channel, account, code)
                .await
        })
    }

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> SessionFuture<
        'a,
        Result<
            crate::channel::status::ChannelStatusOutcome,
            crate::channel::status::ChannelStatusFailure,
        >,
    > {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .status()
                .await
        })
    }

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> SessionFuture<
        'a,
        Result<
            crate::channel::status::ChannelSnapshotOutcome,
            crate::channel::status::ChannelStatusFailure,
        >,
    > {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .snapshot()
                .await
        })
    }

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel::config_read::Outcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .read_channel_config(channel, account_id)
                .await
        })
    }

    fn validate_channel_credentials<'a>(
        &'a self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel::credentials::Outcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .validate_channel_credentials(channel, config)
                .await
        })
    }

    fn channel_catalog<'a>(
        &'a self,
    ) -> SessionFuture<'a, crate::channel::catalog::ChannelCatalogOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .catalog()
                .await
        })
    }

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> SessionFuture<'a, crate::channel::catalog::ChannelConfigureFormOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .configure_form(channel)
                .await
        })
    }

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel::catalog::ChannelConfigureOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .configure(channel, account_id, agent_id, values, false)
                .await
        })
    }

    fn finalize_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel::catalog::ChannelConfigureOutcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .configure(channel, account_id, agent_id, values, true)
                .await
        })
    }

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel::delete::Outcome> {
        Box::pin(async move {
            super::super::adapters::channel::OpenClawChannelProvider::openclaw(self)
                .delete_config(channel, account_id)
                .await
        })
    }
}
