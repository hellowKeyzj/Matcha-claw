use super::*;
use crate::domain::target::{CustomTerminalConfig, CustomTerminalTransport, TargetEndpointBinding};

impl Reader<'_> {
    pub(super) fn target_bindings(&mut self) -> Result<Vec<TargetEndpointBinding>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let target_id =
                    TargetId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let endpoint_id =
                    EndpointId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let revision = self.u64()?;
                TargetEndpointBinding::try_new(
                    target_id,
                    endpoint_id,
                    revision,
                    self.system_time()?,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }

    pub(super) fn targets(
        &mut self,
        with_terminal: bool,
        with_runtime_agent: bool,
    ) -> Result<Vec<(TargetId, u64, FleetTargetConfig)>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let id =
                    TargetId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let revision = self.u64()?;
                if revision == 0 {
                    return Err(StoreFault::CorruptRecord);
                }
                Ok((
                    id,
                    revision,
                    self.target_config(with_terminal, with_runtime_agent)?,
                ))
            })
            .collect()
    }

    pub(super) fn target_config(
        &mut self,
        with_terminal: bool,
        with_runtime_agent: bool,
    ) -> Result<FleetTargetConfig, StoreFault> {
        match self.byte()? {
            0 => {
                let endpoint = self.string()?;
                let container_name = self.string()?;
                let image = self.string()?;
                let bearer_token = self.optional_secret_reference()?;
                let runtime_agent = self.optional_runtime_agent(with_runtime_agent)?;
                Ok(FleetTargetConfig::Docker(
                    DockerTargetConfig::try_new_with_runtime_agent(
                        endpoint,
                        container_name,
                        image,
                        bearer_token,
                        runtime_agent,
                    )
                    .map_err(|_| StoreFault::CorruptRecord)?,
                ))
            }
            1 => {
                let api_server = self.string()?;
                let namespace = self.string()?;
                let deployment_name = self.string()?;
                let service_name = self.string()?;
                let image = self.string()?;
                let bearer_token = self.secret_reference()?;
                let runtime_agent = self.optional_runtime_agent(with_runtime_agent)?;
                Ok(FleetTargetConfig::Kubernetes(
                    KubernetesTargetConfig::try_new_with_runtime_agent(
                        api_server,
                        namespace,
                        deployment_name,
                        service_name,
                        image,
                        bearer_token,
                        runtime_agent,
                    )
                    .map_err(|_| StoreFault::CorruptRecord)?,
                ))
            }
            2 => {
                let host = self.string()?;
                let port = match self.byte()? {
                    0 => None,
                    1 => Some(self.u16()?),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let username = self.optional_string()?;
                let authentication = match self.byte()? {
                    0 => SshAuthentication::PrivateKey(self.secret_reference()?),
                    1 => SshAuthentication::Password(self.secret_reference()?),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let install_command = self.string()?;
                let runtime_agent = self.optional_runtime_agent(with_runtime_agent)?;
                Ok(FleetTargetConfig::Ssh(
                    SshTargetConfig::try_new_with_runtime_agent(
                        host,
                        port,
                        username,
                        authentication,
                        install_command,
                        runtime_agent,
                    )
                    .map_err(|_| StoreFault::CorruptRecord)?,
                ))
            }
            3 => {
                let endpoint = self.string()?;
                let credential = self.optional_secret_reference()?;
                let terminal = if with_terminal {
                    match self.byte()? {
                        0 => None,
                        1 => Some(
                            CustomTerminalConfig::try_new(
                                match self.byte()? {
                                    0 => CustomTerminalTransport::Websocket,
                                    _ => return Err(StoreFault::CorruptRecord),
                                },
                                self.string()?,
                                self.string()?,
                                self.optional_string()?,
                            )
                            .map_err(|_| StoreFault::CorruptRecord)?,
                        ),
                        _ => return Err(StoreFault::CorruptRecord),
                    }
                } else {
                    None
                };
                let runtime_agent = self.optional_runtime_agent(with_runtime_agent)?;
                Ok(FleetTargetConfig::Custom(
                    CustomTargetConfig::try_new_with_terminal_and_runtime_agent(
                        endpoint,
                        credential,
                        terminal,
                        runtime_agent,
                    )
                    .map_err(|_| StoreFault::CorruptRecord)?,
                ))
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn optional_runtime_agent(
        &mut self,
        present: bool,
    ) -> Result<Option<crate::domain::target::RuntimeAgentEndpointConfig>, StoreFault> {
        if !present {
            return Ok(None);
        }
        match self.byte()? {
            0 => Ok(None),
            1 => crate::domain::target::RuntimeAgentEndpointConfig::try_new(
                self.string()?,
                self.secret_reference()?,
            )
            .map(Some)
            .map_err(|_| StoreFault::CorruptRecord),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn secret_reference(&mut self) -> Result<FleetSecretRef, StoreFault> {
        FleetSecretRef::from_serialized(self.string()?).map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn optional_secret_reference(
        &mut self,
    ) -> Result<Option<FleetSecretRef>, StoreFault> {
        self.optional_string()?
            .map(FleetSecretRef::from_serialized)
            .transpose()
            .map_err(|_| StoreFault::CorruptRecord)
    }
}
