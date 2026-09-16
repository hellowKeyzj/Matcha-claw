use super::*;

impl ConnectorOps for OpenClawInstance {
    fn apply_runtime_mcp_projection<'a>(
        &'a self,
        preset: Option<openclaw::projection::connector::preset::PresetMcpProjection<'a>>,
        catalog: environment::connectors::ConnectorCatalog,
        secrets: &'a dyn environment::ConnectorSecretResolverPort,
    ) -> SessionFuture<'a, openclaw::projection::connector::external::ConnectorProjectionEffect>
    {
        Box::pin(async move {
            openclaw::projection::connector::external::project_runtime_mcp_connectors(
                self.state_dir.clone(),
                preset,
                &catalog,
                secrets,
            )
            .map(|(effect, _)| effect)
            .unwrap_or(
                openclaw::projection::connector::external::ConnectorProjectionEffect::Unavailable,
            )
        })
    }

    fn probe_external_connector<'a>(
        &'a self,
        connector: environment::connectors::Connector,
    ) -> SessionFuture<'a, openclaw::projection::connector::external::ConnectorObservation> {
        Box::pin(async move {
            openclaw::projection::connector::external::probe_external_connector(&connector).await
        })
    }

    fn list_mcp_servers<'a>(
        &'a self,
    ) -> SessionFuture<
        'a,
        Result<
            Vec<openclaw::projection::connector::config::OpenClawMcpServerConfig>,
            crate::runtime::driver::RuntimeOperationFailure,
        >,
    > {
        Box::pin(async move {
            openclaw::projection::connector::config::read_mcp_servers(self.state_dir.clone())
                .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)
        })
    }

    fn observe_mcp_server_status<'a>(
        &'a self,
        session_key: String,
    ) -> SessionFuture<
        'a,
        Result<
            openclaw::gateway::wire::McpServerStatusList,
            crate::runtime::driver::RuntimeOperationFailure,
        >,
    > {
        Box::pin(async move {
            self.gateway
                .lock()
                .await
                .observe_mcp_server_status(session_key)
                .await
                .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)
        })
    }

    fn set_mcp_session_server_enabled<'a>(
        &'a self,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> SessionFuture<'a, Result<(), crate::runtime::driver::RuntimeOperationFailure>> {
        Box::pin(async move {
            self.gateway
                .lock()
                .await
                .set_mcp_session_server_enabled(session_key, server_name, enabled)
                .await
                .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)
        })
    }
}
