use super::*;

impl Reader<'_> {
    pub(super) fn connections(&mut self) -> Result<Vec<ConnectionRecord>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let id = crate::domain::connection::ConnectionId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let kind = match self.byte()? {
                    0 => ConnectionKind::SshHost,
                    1 => ConnectionKind::Container,
                    2 => ConnectionKind::Vm,
                    3 => ConnectionKind::KubernetesPod,
                    4 => ConnectionKind::Custom,
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let name = self.string()?;
                let endpoint = self.optional_string()?;
                let labels = (0..self.count()?)
                    .map(|_| self.string())
                    .collect::<Result<Vec<_>, _>>()?;
                let enabled = self.byte()? != 0;
                let public = self.string_map()?;
                let secrets = self.secret_map()?;
                let state = self.connection_state()?;
                let created = self.system_time()?;
                let updated = self.system_time()?;
                ConnectionRecord::restore(
                    id, kind, name, endpoint, labels, enabled, public, secrets, state, created,
                    updated,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }
    pub(super) fn environments(
        &mut self,
        with_resource_metadata: bool,
    ) -> Result<(Vec<EnvironmentRecord>, Vec<ManagedResourceRecord>), StoreFault> {
        let environments = (0..self.count()?)
            .map(|_| {
                let id = EnvironmentId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let connection = crate::domain::connection::ConnectionId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let name = self.string()?;
                let kind = environment_kind(self.byte()?)?;
                let labels = (0..self.count()?)
                    .map(|_| self.string())
                    .collect::<Result<Vec<_>, _>>()?;
                let enabled = self.byte()? != 0;
                let public = self.string_map()?;
                let secrets = self.secret_map()?;
                let state = self.environment_state()?;
                let ids = (0..self.count()?)
                    .map(|_| {
                        ManagedResourceId::try_new(self.string()?)
                            .map_err(|_| StoreFault::CorruptRecord)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let created = self.system_time()?;
                let updated = self.system_time()?;
                EnvironmentRecord::restore(
                    id, connection, name, kind, labels, enabled, public, secrets, state, ids,
                    created, updated,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let resources = (0..self.count()?)
            .map(|_| {
                let id = ManagedResourceId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let connection = crate::domain::connection::ConnectionId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let environment = EnvironmentId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let provider = provider_kind(self.byte()?)?;
                let kind = resource_kind(self.byte()?)?;
                let remote = self.string()?;
                let ownership = ownership(self.byte()?)?;
                let cleanup = cleanup(self.byte()?)?;
                let state = self.resource_state()?;
                let tombstone = self.byte()? != 0;
                let created = self.system_time()?;
                let updated = self.system_time()?;
                let metadata = if with_resource_metadata {
                    self.resource_metadata()?
                } else {
                    None
                };
                ManagedResourceRecord::restore_with_metadata(
                    id,
                    connection,
                    environment,
                    provider,
                    kind,
                    remote,
                    ownership,
                    cleanup,
                    state,
                    tombstone,
                    created,
                    updated,
                    metadata,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((environments, resources))
    }
    pub(super) fn resource_metadata(
        &mut self,
    ) -> Result<Option<ManagedResourceMetadata>, StoreFault> {
        if self.byte()? == 0 {
            return Ok(None);
        }
        let display_name = self.string()?;
        let labels = self.string_map()?;
        let remote_refs = (0..self.count()?)
            .map(|_| {
                ManagedResourceRef::try_new(
                    provider_kind(self.byte()?)?,
                    resource_kind(self.byte()?)?,
                    self.string()?,
                    self.optional_string()?,
                    self.optional_string()?,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let ownership_evidence = self.string_map()?;
        let association = match self.byte()? {
            0 => ManagedResourceAssociation::docker_container(self.string()?),
            1 => ManagedResourceAssociation::kubernetes_workload(
                self.string()?,
                self.string()?,
                self.string()?,
            ),
            _ => return Err(StoreFault::CorruptRecord),
        }
        .map_err(|_| StoreFault::CorruptRecord)?;
        let observed_at = self.system_time()?;
        ManagedResourceMetadata::try_new(
            display_name,
            labels,
            remote_refs,
            ownership_evidence,
            association,
            observed_at,
        )
        .map(Some)
        .map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn string_map(
        &mut self,
    ) -> Result<std::collections::BTreeMap<String, String>, StoreFault> {
        let mut m = std::collections::BTreeMap::new();
        for _ in 0..self.count()? {
            if m.insert(self.string()?, self.string()?).is_some() {
                return Err(StoreFault::CorruptRecord);
            }
        }
        Ok(m)
    }
    pub(super) fn secret_map(
        &mut self,
    ) -> Result<std::collections::BTreeMap<String, FleetSecretRef>, StoreFault> {
        let mut m = std::collections::BTreeMap::new();
        for _ in 0..self.count()? {
            let k = self.string()?;
            let v = FleetSecretRef::from_serialized(self.string()?)
                .map_err(|_| StoreFault::CorruptRecord)?;
            if m.insert(k, v).is_some() {
                return Err(StoreFault::CorruptRecord);
            }
        }
        Ok(m)
    }
    pub(super) fn connection_state(&mut self) -> Result<ConnectionState, StoreFault> {
        Ok(match self.byte()? {
            0 => ConnectionState::Registered,
            1 => ConnectionState::Probing {
                command_id: CommandId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
            },
            2 => ConnectionState::Ready {
                observed_at: self.system_time()?,
            },
            3 => ConnectionState::Unhealthy {
                observed_at: self.optional_system_time()?,
                message: self.string()?,
            },
            4 => ConnectionState::Deleted {
                deleted_at: self.system_time()?,
            },
            5 => ConnectionState::Failed {
                message: self.string()?,
            },
            _ => return Err(StoreFault::CorruptRecord),
        })
    }
    pub(super) fn environment_state(&mut self) -> Result<EnvironmentState, StoreFault> {
        Ok(match self.byte()? {
            0 => EnvironmentState::Registered,
            1 => EnvironmentState::Deploying {
                command_id: CommandId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
                phase: PhaseKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
            },
            2 => EnvironmentState::Ready {
                ready_at: self.system_time()?,
            },
            3 => EnvironmentState::Deleting {
                command_id: CommandId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
                phase: PhaseKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
            },
            4 => EnvironmentState::Deleted {
                deleted_at: self.system_time()?,
            },
            5 => EnvironmentState::Orphaned {
                message: self.optional_string()?,
            },
            6 => EnvironmentState::Failed {
                message: self.string()?,
            },
            _ => return Err(StoreFault::CorruptRecord),
        })
    }
    pub(super) fn resource_state(&mut self) -> Result<ManagedResourceState, StoreFault> {
        Ok(match self.byte()? {
            0 => ManagedResourceState::Observed,
            1 => ManagedResourceState::Provisioning {
                command_id: CommandId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
                phase: PhaseKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
            },
            2 => ManagedResourceState::Ready {
                observed_at: self.system_time()?,
            },
            3 => ManagedResourceState::Deleting {
                command_id: CommandId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
                phase: PhaseKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
            },
            4 => ManagedResourceState::Deleted {
                deleted_at: self.system_time()?,
            },
            5 => ManagedResourceState::Conflict {
                message: self.string()?,
            },
            6 => ManagedResourceState::Failed {
                message: self.string()?,
            },
            _ => return Err(StoreFault::CorruptRecord),
        })
    }
}
