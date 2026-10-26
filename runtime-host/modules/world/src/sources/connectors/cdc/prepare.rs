use super::super::{SourceBroker, SourceError, metadata, prepared::Driver, values};
use crate::{
    authorization::Admission,
    extensions::invocation,
    sources::{
        mapping,
        sync::{Assignment, SyncError},
    },
};
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    ids::*,
    sources::*,
};

/// Exact native metadata and pinned implementation, never a wire-authorized assignment.
pub(crate) struct SyncPreparation {
    binding: Definition<SourceBinding>,
    plan: CompiledSourcePlan,
    read: SourceReadPlan,
    instance: InvocationLeaseId,
    implementation: world_protocol::bindings::ImplementationRef,
    format: CheckpointFormatId,
}
impl SyncPreparation {
    pub(crate) fn binding(&self) -> &Definition<SourceBinding> {
        &self.binding
    }
    pub(crate) fn plan(&self) -> &CompiledSourcePlan {
        &self.plan
    }
    pub(crate) fn read(&self) -> &SourceReadPlan {
        &self.read
    }
    pub(crate) fn assignment(&self, epoch: PartitionEpoch) -> Assignment {
        let b = &self.binding.body;
        Assignment {
            world: self.binding.reference.world.clone(),
            source_id: b.source_id.clone(),
            incarnation: b.incarnation.clone(),
            partition: b.resource.clone(),
            epoch,
            instance: self.instance.clone(),
            implementation: self.implementation.clone(),
            binding: self.binding.reference.clone(),
            connection_id: b.connection_id.clone(),
            connection_revision: b.connection_revision,
            mapping: b.mapping.clone(),
            schema: b.schema.clone(),
            identity_rule: b.identity_rule.clone(),
            scope: b.scope.clone(),
            format: self.format.clone(),
        }
    }
}
impl SourceBroker {
    pub(in crate::sources) async fn recheck_sync_assignment(
        &self, admission: &Admission, assignment: &Assignment,
    ) -> Result<(), SourceError> {
        if assignment.instance != *self.lease.id() || assignment.implementation != *self.prepared.implementation() {
            return Err(values::invalid_response("sourceAssignment"));
        }
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await.map_err(super::super::current_error)?;
        let admission = admission.clone();
        let assignment = assignment.clone();
        self.store.snapshot(assignment.world.clone(), move |snapshot| Box::pin(async move {
            crate::authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
            crate::sources::sync::recheck_assignment(snapshot, &assignment).await?;
            Ok(())
        })).await
    }
    pub(in crate::sources) fn renewal_assignment(&self, previous: &Assignment) -> Assignment {
        let mut assignment = previous.clone();
        assignment.instance = self.lease.id().clone();
        assignment.implementation = self.prepared.implementation().clone();
        assignment
    }
    pub(in crate::sources) async fn fence_sync_cleanup(
        &self, admission: &Admission, assignment: &Assignment, read: &SourceReadPlan,
        cancel: tokio_util::sync::CancellationToken, deadline: tokio::time::Instant,
    ) -> Result<super::NativeSourceFence, SourceError> {
        if assignment.instance != *self.lease.id() || assignment.implementation != *self.prepared.implementation() {
            return Err(values::invalid_response("sourceAssignment"));
        }
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await.map_err(super::super::current_error)?;
        let metadata = metadata::read(&self.store, admission, read, &self.prepared).await?;
        if metadata.binding.reference != assignment.binding || metadata.connection.id != assignment.connection_id
            || metadata.connection.revision != assignment.connection_revision { return Err(values::invalid_response("sourceAssignment")); }
        let access = self.native_access()?;
        let credential = access.credentials(&metadata.connection.world, &metadata.connection.id,
            metadata.connection.revision, cancel.clone(), deadline).await?;
        super::postgres::NativeSourceFence::acquire(access, &metadata, &assignment.instance, credential, cancel, deadline).await
    }
    pub(crate) fn sync_drained(&self) -> bool {
        self.lease.ledger(&self.provider).is_some_and(|ledger| {
            ledger.snapshot().resources.iter().all(|resource| {
                resource.spec.invocation.as_ref() != Some(self.lease.invocation())
                    || matches!(
                        resource.spec.kind,
                        invocation::ResourceKind::Invocation
                            | invocation::ResourceKind::Dependency
                            | invocation::ResourceKind::Registration
                    )
            })
        })
    }
    pub(crate) async fn prepare_sync(
        &self,
        reference: &DefinitionRef,
        admission: &Admission,
    ) -> Result<SyncPreparation, SyncError> {
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await
            .map_err(super::super::current_error)?;
        let reference = reference.clone();
        let binding = self
            .store
            .snapshot(reference.world.clone(), move |snapshot| {
                Box::pin(async move {
                    mapping::read_binding_snapshot(snapshot, &reference)
                        .await?
                        .ok_or_else(|| SyncError::from(MappingFailure::RevisionMismatch))
                })
            })
            .await?;
        let read = SourceReadPlan {
            binding: binding.reference.clone(),
            resource: binding.body.resource.clone(),
            row_symbol: SymbolId::try_new("source_row").map_err(|_| SyncError::protocol())?,
            fields: binding
                .body
                .selected_fields
                .iter()
                .map(ToString::to_string)
                .collect(),
            predicate: None,
            order: Vec::new(),
            limit: world_protocol::api::MAX_PAGE_ITEMS,
            continuation: None,
            as_of: None,
        };
        let metadata = metadata::read(&self.store, admission, &read, &self.prepared).await?;
        if metadata.binding != binding {
            return Err(SyncError::protocol());
        }
        let format = checkpoint_format(
            &metadata.connection.config,
            self.prepared.driver(),
            &binding.body,
            &read,
        )?;
        let exact = binding.clone();
        let plan = self
            .store
            .snapshot(binding.reference.world.clone(), move |snapshot| {
                Box::pin(async move {
                    let schema = mapping::read_schema_snapshot(snapshot, &exact.body.schema)
                        .await?
                        .ok_or_else(SyncError::protocol)?;
                    let mapping = mapping::read_mapping_snapshot(snapshot, &exact.body.mapping)
                        .await?
                        .ok_or_else(SyncError::protocol)?;
                    let authority = mapping::read_authority_snapshot(
                        snapshot,
                        &exact.reference,
                        &exact.body.authority,
                    )
                    .await?
                    .ok_or_else(SyncError::protocol)?;
                    let mut field_definitions = Vec::new();
                    let mut relation_definitions = Vec::new();
                    for field in &mapping.fields {
                        if field_definitions.iter().any(
                            |d: &Definition<world_protocol::definitions::Property>| {
                                d.reference == field.property
                            },
                        ) {
                            continue;
                        }
                        let d = mapping::published_definition_snapshot(snapshot, &field.property)
                            .await?
                            .ok_or_else(SyncError::protocol)?;
                        let DefinitionBody::Property(body) = d.body else {
                            return Err(SyncError::protocol());
                        };
                        field_definitions.push(Definition {
                            reference: d.reference,
                            scope: d.scope,
                            valid_time: d.valid_time,
                            body,
                            content_digest: d.content_digest,
                            dependencies: d.dependencies,
                            evidence: d.evidence,
                            previous_ref: d.previous_ref,
                            lifecycle: d.lifecycle,
                        });
                    }
                    for relation in &mapping.relations {
                        if relation_definitions.iter().any(
                            |d: &Definition<world_protocol::definitions::RelationType>| {
                                d.reference == relation.relation_type
                            },
                        ) {
                            continue;
                        }
                        let d = mapping::published_definition_snapshot(
                            snapshot,
                            &relation.relation_type,
                        )
                        .await?
                        .ok_or_else(SyncError::protocol)?;
                        let DefinitionBody::RelationType(body) = d.body else {
                            return Err(SyncError::protocol());
                        };
                        relation_definitions.push(Definition {
                            reference: d.reference,
                            scope: d.scope,
                            valid_time: d.valid_time,
                            body,
                            content_digest: d.content_digest,
                            dependencies: d.dependencies,
                            evidence: d.evidence,
                            previous_ref: d.previous_ref,
                            lifecycle: d.lifecycle,
                        });
                    }
                    Ok::<_, SyncError>(mapping::compile_plan(CompileSourceRequest {
                        binding: exact,
                        schema,
                        mapping,
                        authority,
                        field_definitions,
                        relation_definitions,
                    })?)
                })
            })
            .await?;
        if plan.schema != metadata.schema {
            return Err(SyncError::protocol());
        }
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await
            .map_err(super::super::current_error)?;
        Ok(SyncPreparation {
            binding,
            plan,
            read,
            instance: self.lease.id().clone(),
            implementation: self.prepared.implementation().clone(),
            format,
        })
    }

    /// The assignment is attested by the same native lease and metadata that produced the page.
    pub(crate) fn branch_assignment(
        &self,
        read: &super::super::ReadSourcePage,
        plan: &CompiledSourcePlan,
    ) -> Result<Assignment, SyncError> {
        let b = &plan.binding_body;
        if read.implementation() != self.prepared.implementation()
            || read.metadata.binding.body != *b
            || read.metadata.binding.reference != plan.binding
            || read.lease.id() != self.lease.id()
            || read.provider != self.provider
        {
            return Err(SyncError::protocol());
        }
        let source_read = SourceReadPlan {
            binding: plan.binding.clone(),
            resource: b.resource.clone(),
            row_symbol: SymbolId::try_new("source_row").map_err(|_| SyncError::protocol())?,
            fields: b.selected_fields.iter().map(ToString::to_string).collect(),
            predicate: None,
            order: Vec::new(),
            limit: world_protocol::api::MAX_PAGE_ITEMS,
            continuation: None,
            as_of: None,
        };
        let format = checkpoint_format(
            &read.connection.config,
            self.prepared.driver(),
            b,
            &source_read,
        )?;
        Ok(Assignment {
            world: plan.binding.world.clone(),
            source_id: b.source_id.clone(),
            incarnation: b.incarnation.clone(),
            partition: b.resource.clone(),
            epoch: PartitionEpoch(1),
            instance: self.lease.id().clone(),
            implementation: self.prepared.implementation().clone(),
            binding: plan.binding.clone(),
            connection_id: b.connection_id.clone(),
            connection_revision: b.connection_revision,
            mapping: b.mapping.clone(),
            schema: b.schema.clone(),
            identity_rule: b.identity_rule.clone(),
            scope: b.scope.clone(),
            format,
        })
    }
}

fn checkpoint_format(
    config: &SourceConnectionConfig,
    driver: Driver,
    binding: &SourceBinding,
    read: &SourceReadPlan,
) -> Result<CheckpointFormatId, SyncError> {
    Ok(match (config, driver) {
        (SourceConnectionConfig::Postgres(config), Driver::Postgres) => {
            // One slot is one ACK frontier. Multiple resources would acknowledge unseen partitions.
            if matches!(binding.sync, SyncPolicy::ChangeStream)
                && (config.logical.is_none()
                    || config.resources.len() != 1
                    || config.resources[0].id != read.resource)
            {
                return Err(SourceError::invalid("logical", SourcePlanReason::InvalidValue).into());
            }
            CheckpointFormatId::try_new("postgres.wal2json.v2")
                .map_err(|_| SyncError::protocol())?
        }
        (SourceConnectionConfig::HttpJson(config), Driver::HttpJson) => {
            if let Some(changes) = &config.changes {
                changes.format.clone()
            } else if matches!(binding.sync, SyncPolicy::ChangeStream | SyncPolicy::Webhook) {
                return Err(super::missing().into());
            } else {
                CheckpointFormatId::try_new("http.snapshot.v1")
                    .map_err(|_| SyncError::protocol())?
            }
        }
        (SourceConnectionConfig::Plugin(_), Driver::Plugin) => {
            if matches!(binding.sync, SyncPolicy::ChangeStream | SyncPolicy::Webhook) {
                return Err(super::missing().into());
            }
            CheckpointFormatId::try_new("plugin.snapshot.v1").map_err(|_| SyncError::protocol())?
        }
        _ => return Err(values::invalid_response("driver").into()),
    })
}
