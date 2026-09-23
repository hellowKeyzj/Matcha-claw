use connectors::ports::ConnectorOps;

use crate::driver::OpenClawDriver;

impl ConnectorOps for OpenClawDriver {
    fn apply_runtime_mcp_projection<'a>(
        &'a self,
        preset: Option<::connectors::ports::TeamRunMcpPreset<'a>>,
        catalog: ::connectors::ConnectorCatalog,
        secrets: &'a dyn ::connectors::ConnectorSecretResolverPort,
    ) -> ::connectors::ports::ConnectorFuture<'a, ::connectors::ports::ConnectorProjectionEffect>
    {
        Box::pin(async move {
            crate::surfaces::connectors::apply_runtime_mcp_projection(
                self.state_dir.clone(),
                preset,
                &catalog,
                secrets,
            )
        })
    }

    fn probe_external_connector<'a>(
        &'a self,
        connector: ::connectors::Connector,
    ) -> ::connectors::ports::ConnectorFuture<'a, ::connectors::ports::ConnectorObservation> {
        Box::pin(
            async move { crate::surfaces::connectors::probe_external_connector(&connector).await },
        )
    }

    fn list_mcp_servers<'a>(
        &'a self,
    ) -> ::connectors::ports::ConnectorFuture<
        'a,
        Result<
            Vec<::connectors::ports::McpServerConfig>,
            ::connectors::ports::ConnectorOperationFailure,
        >,
    > {
        Box::pin(
            async move { crate::surfaces::connectors::read_mcp_servers(self.state_dir.clone()) },
        )
    }

    fn observe_mcp_server_status<'a>(
        &'a self,
        session_key: String,
    ) -> ::connectors::ports::ConnectorFuture<
        'a,
        Result<
            ::connectors::ports::McpServerStatusList,
            ::connectors::ports::ConnectorOperationFailure,
        >,
    > {
        Box::pin(async move {
            let mut gateway = self.gateway.lock().await;
            crate::surfaces::connectors::observe_mcp_server_status(&mut *gateway, session_key).await
        })
    }

    fn set_mcp_session_server_enabled<'a>(
        &'a self,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> ::connectors::ports::ConnectorFuture<
        'a,
        Result<(), ::connectors::ports::ConnectorOperationFailure>,
    > {
        Box::pin(async move {
            let mut gateway = self.gateway.lock().await;
            crate::surfaces::connectors::set_mcp_session_server_enabled(
                &mut *gateway,
                session_key,
                server_name,
                enabled,
            )
            .await
        })
    }
}
