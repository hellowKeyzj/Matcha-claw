use zeroize::Zeroizing;

use crate::port::OpenClawGateway;
use crate::surfaces::{
    channels::gateway::{
        config::{
            ChannelCatalogEffect, ChannelConfigMutationOutcome, ChannelConfigOperation,
            ChannelConfigReadEffect, ChannelConfigSchemaEffect, DeleteConfigOutcome,
        },
        control::{ChannelControlEffect, ChannelControlOperation},
        credentials::{ChannelCredentialsEffect, ChannelCredentialsOperation},
        login::{
            ChannelRuntimeAction, ChannelRuntimeEffect, WebLoginStart, WebLoginStartEffect,
            WebLoginWait, WebLoginWaitEffect,
        },
        pairing::{ChannelPairingApprovalEffect, ChannelPairingEffect, ChannelPairingOperation},
        status::{ChannelSnapshotEffect, ChannelStatusEffect, ChannelStatusOperation},
    },
    plugins::gateway::refresh::{PluginRefreshOperation, PluginRefreshOutcome},
};

impl OpenClawGateway {
    pub fn with_openclaw_dir(mut self, openclaw_dir: std::path::PathBuf) -> Self {
        self.set_openclaw_dir(openclaw_dir);
        self
    }

    pub fn with_channel_schema_source(
        mut self,
        executable: std::path::PathBuf,
        managed_plugin_root: std::path::PathBuf,
    ) -> Self {
        self.set_channel_schema_source(executable, managed_plugin_root);
        self
    }

    pub fn with_channel_pairing_operation(mut self, operation: ChannelPairingOperation) -> Self {
        self.set_channel_pairing_operation(operation);
        self
    }

    pub fn with_channel_credentials_operation(
        mut self,
        operation: ChannelCredentialsOperation,
    ) -> Self {
        self.set_channel_credentials_operation(operation);
        self
    }

    pub async fn validate_channel_credentials(
        &self,
        channel: String,
        account: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> ChannelCredentialsEffect {
        match self.channel_credentials_operation() {
            Some(credentials) => credentials.validate(channel, account, config).await,
            None => ChannelCredentialsEffect::OutcomeUnknown,
        }
    }

    pub async fn list_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
    ) -> ChannelPairingEffect {
        ChannelPairingOperation::list(&self.client(), channel, account).await
    }

    pub async fn approve_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> ChannelPairingApprovalEffect {
        match self.channel_pairing_operation() {
            Some(pairing) => pairing.approve(channel, account, code).await,
            None => ChannelPairingApprovalEffect::OutcomeUnknown,
        }
    }

    pub async fn channel_catalog(&self, runtime_running: bool) -> ChannelCatalogEffect {
        ChannelConfigOperation::new(self.client(), self.state_dir(), runtime_running)
            .catalog()
            .await
    }

    pub async fn channel_configure_form(
        &self,
        channel: String,
        runtime_running: bool,
    ) -> ChannelConfigSchemaEffect {
        ChannelConfigOperation::new(self.client(), self.state_dir(), runtime_running)
            .with_openclaw_dir(self.openclaw_dir())
            .with_channel_schema_source(self.schema_executable(), self.managed_plugin_root())
            .form(channel)
            .await
    }

    pub async fn read_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
        runtime_running: bool,
    ) -> ChannelConfigReadEffect {
        ChannelConfigOperation::new(self.client(), self.state_dir(), runtime_running)
            .with_openclaw_dir(self.openclaw_dir())
            .with_channel_schema_source(self.schema_executable(), self.managed_plugin_root())
            .read(channel, account_id)
            .await
    }

    pub async fn configure_channel(
        &self,
        channel: String,
        account_id: String,
        patch: serde_json::Map<String, serde_json::Value>,
        plugin_id: Option<String>,
        agent_id: Option<String>,
        runtime_running: bool,
        login_completed: bool,
    ) -> ChannelConfigMutationOutcome {
        let operation =
            ChannelConfigOperation::new(self.client(), self.state_dir(), runtime_running);
        if login_completed {
            operation
                .finalize_login(channel, account_id, patch, plugin_id, agent_id)
                .await
        } else {
            operation
                .configure(channel, account_id, patch, plugin_id, agent_id)
                .await
        }
    }

    pub async fn refresh_plugins(&self) -> PluginRefreshOutcome {
        PluginRefreshOperation::new(self.client()).refresh().await
    }

    pub async fn delete_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
        runtime_running: bool,
    ) -> DeleteConfigOutcome {
        ChannelConfigOperation::new(self.client(), self.state_dir(), runtime_running)
            .with_openclaw_dir(self.openclaw_dir())
            .delete_config(channel, account_id)
            .await
    }

    pub fn channel_login_operation(
        &self,
    ) -> crate::surfaces::channels::gateway::login::ChannelLoginOperation {
        crate::surfaces::channels::gateway::login::ChannelLoginOperation::new(self.client())
    }

    pub async fn channel_runtime(
        &self,
        action: ChannelRuntimeAction,
        channel: String,
        account: Option<String>,
    ) -> ChannelRuntimeEffect {
        self.channel_login_operation()
            .runtime(action, channel, account)
            .await
    }

    pub async fn web_login_start(
        &self,
        channel: String,
        input: WebLoginStart,
    ) -> WebLoginStartEffect {
        self.channel_login_operation()
            .login_start(channel, input)
            .await
    }

    pub async fn web_login_wait_with_cancellation(
        &self,
        channel: String,
        input: WebLoginWait,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> WebLoginWaitEffect {
        self.channel_login_operation()
            .login_wait_with_cancellation(channel, input, cancellation)
            .await
    }

    pub async fn connect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> ChannelControlEffect {
        ChannelControlOperation::new(self.client())
            .connect(channel, account)
            .await
    }

    pub async fn disconnect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> ChannelControlEffect {
        ChannelControlOperation::new(self.client())
            .disconnect(channel, account)
            .await
    }

    pub async fn observe_channel_accounts(&self, runtime_running: bool) -> ChannelStatusEffect {
        ChannelStatusOperation::new(self.client(), self.state_dir(), runtime_running)
            .observe()
            .await
    }

    pub async fn observe_channel_snapshot(&self, runtime_running: bool) -> ChannelSnapshotEffect {
        ChannelStatusOperation::new(self.client(), self.state_dir(), runtime_running)
            .observe_snapshot()
            .await
    }
}
