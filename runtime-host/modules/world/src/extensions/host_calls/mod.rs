mod error;

use std::sync::Arc;

use sha2::{Digest as _, Sha256};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    bindings::{BindingFailure, PortDirection, SlotKind},
    budget::BudgetDimension,
    expression::Effect,
    failure::{FailureStage, FieldPath, InputFailure},
    ids::*,
    materials::SourceVersionRef,
    package::RequestedAccess,
    process::{self, HostFailure, HostRequest, HostResponse},
};

use crate::{
    content::Content,
    extensions::{
        invocation::InvocationContext,
        migration::{self, StateLimits},
    },
    generation::BoundGeneration,
    sources::connectors::SourceBroker,
    store::CommitRequest,
};
pub(crate) use error::HostCallFailure;

#[derive(Clone)]
pub(crate) struct HostCallServices {
    pub source: Option<Arc<SourceBroker>>,
    pub sources: crate::query::SourceBrokers,
    pub content: Arc<Content>,
    pub generation: Option<Arc<dyn BoundGeneration>>,
    pub model_calls: Arc<crate::generation::GenerationRecovery>,
    pub state_limits: StateLimits,
    pub source_versions: Vec<SourceVersionRef>,
}

impl HostCallServices {
    pub(crate) fn for_context(&self, context: &InvocationContext) -> Result<Self, HostCallFailure> {
        let mut services = self.clone();
        let provider = if context.lease().source(context.node()).is_some() {
            Some(context.node())
        } else if let Some(provider) = context.lease().provider(context.node(), "source.read") {
            let expected =
                world_protocol::slots::slot_port(SlotKind::Connector).map_err(|cause| {
                    HostCallFailure::caused_by(
                        HostFailure::InternalFault,
                        FailureStage::Validate,
                        cause,
                    )
                })?;
            let consumer = context
                .lease()
                .graph()
                .node(context.node())
                .map_err(|failure| {
                    HostCallFailure::new(HostFailure::Binding(failure), FailureStage::Admission)
                })?;
            if !consumer.ports.iter().any(|port| {
                port.direction == PortDirection::Import
                    && port.name == expected.name
                    && port.contract == expected.contract
                    && port.request_schema == expected.request_schema
                    && port.result_schema == expected.result_schema
            }) {
                return Err(missing("source.read"));
            }
            Some(provider)
        } else {
            None
        };
        services.source = match provider {
            None => None,
            Some(provider) => {
                let binding = context.lease().graph().node(provider).map_err(|failure| {
                    HostCallFailure::new(HostFailure::Binding(failure), FailureStage::Admission)
                })?;
                let source = self
                    .sources
                    .get(&binding.provider_id)
                    .ok_or_else(|| missing("source.read"))?;
                if !source.matches_invocation(context.lease(), provider) {
                    return Err(invalid("source.provider"));
                }
                source.rebind(context.node().clone())?.map(Arc::new)
            }
        };
        Ok(services)
    }
}

/// Both component and process imports use these same current host-owned call facts.
pub(crate) struct HostCallContext {
    context: InvocationContext,
    services: HostCallServices,
}
impl HostCallContext {
    pub(crate) fn new(
        context: InvocationContext,
        services: HostCallServices,
    ) -> Result<Self, HostCallFailure> {
        if services.content.world() != &context.admission().invocation().world
            || services
                .source
                .as_ref()
                .is_some_and(|source| !source.matches_invocation(context.lease(), context.node()))
            || services
                .source_versions
                .iter()
                .any(|source| source.world != context.admission().invocation().world)
        {
            return Err(HostCallFailure::new(
                HostFailure::Authorization(
                    world_protocol::authorization::AuthorizationFailure::InsufficientScope,
                ),
                FailureStage::Admission,
            ));
        }
        let expected = world_protocol::slots::slot_port(SlotKind::Connector).map_err(|cause| {
            HostCallFailure::caused_by(HostFailure::InternalFault, FailureStage::Validate, cause)
        })?;
        for (provider, broker) in &services.sources {
            let mut nodes = context.lease().closure().nodes.iter().filter(|id| {
                context.lease().graph().node(id).is_ok_and(|node| {
                    node.slot == SlotKind::Connector
                        && &node.provider_id == provider
                        && node.implementation.contracts.contains(&expected.contract)
                        && node
                            .ports
                            .iter()
                            .filter(|port| {
                                port.direction == PortDirection::Export
                                    && port.name == expected.name
                            })
                            .eq(std::iter::once(&expected))
                })
            });
            if nodes
                .next()
                .is_none_or(|node| !broker.matches_invocation(context.lease(), node))
                || nodes.next().is_some()
            {
                return Err(invalid("source.providers"));
            }
        }
        Ok(Self { context, services })
    }

    pub(crate) fn matches(&self, context: &InvocationContext) -> bool {
        self.context.same_call(context)
    }

    pub(crate) async fn execute(
        &self,
        request: HostRequest,
        call_key: &str,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<HostResponse, HostCallFailure> {
        if call_key.is_empty() || call_key.len() > 1024 || call_key.chars().any(char::is_control) {
            return Err(invalid("call_key"));
        }
        self.context.check_current().await?;
        self.context
            .budget()
            .check()
            .map_err(|error| budget_error(error.dimension))?;
        if cancel.is_cancelled() || self.context.pipeline().is_cancelled() {
            return Err(HostCallFailure::new(
                HostFailure::Cancelled,
                FailureStage::Execute,
            ));
        }
        let deadline = deadline.min(self.context.budget().deadline());
        if Instant::now() >= deadline {
            return Err(budget_error(BudgetDimension::Deadline));
        }
        let port = process::host_request_port(&request).map_err(|cause| {
            HostCallFailure::caused_by(HostFailure::InternalFault, FailureStage::Validate, cause)
        })?;
        let node = self
            .context
            .lease()
            .graph()
            .node(self.context.node())
            .map_err(|failure| {
                HostCallFailure::new(HostFailure::Binding(failure), FailureStage::Admission)
            })?;
        if !node.ports.iter().any(|actual| {
            actual.direction == PortDirection::Import
                && actual.name == port.name
                && actual.contract == port.contract
                && actual.request_schema == port.request_schema
                && actual.result_schema == port.result_schema
        }) {
            return Err(HostCallFailure::new(
                HostFailure::Binding(BindingFailure::MissingPort {
                    node_id: node.id.clone(),
                    port: port.name,
                }),
                FailureStage::Admission,
            ));
        }
        let required = self.required_access(&request).await?;
        self.require_grants(required).await?;
        let committed = matches!(
            &request,
            HostRequest::WorldRead(_) | HostRequest::ModelGenerate(_) | HostRequest::StateWrite(_)
        );
        let response = match &request {
            HostRequest::SourceRead(plan) => {
                let broker = self
                    .services
                    .source
                    .as_ref()
                    .ok_or_else(|| missing("source.read"))?;
                HostResponse::SourceRead(
                    broker
                        .read(
                            plan.clone(),
                            self.context.admission(),
                            self.context.pipeline(),
                            cancel.clone(),
                            deadline,
                            self.context.budget().clone(),
                        )
                        .await?,
                )
            }
            HostRequest::WorldRead(request) => HostResponse::WorldRead(
                self.world_read(request, call_key, &cancel, deadline)
                    .await?,
            ),
            HostRequest::ModelGenerate(request) => {
                let bound = self
                    .services
                    .generation
                    .as_ref()
                    .ok_or_else(|| missing("model.generate"))?
                    .clone();
                let recorded = crate::generation::generate(
                    self.context.store(),
                    &self.services.model_calls,
                    self.context.admission(),
                    self.context.pipeline(),
                    self.context.budget(),
                    self.services.content.clone(),
                    bound,
                    request.clone(),
                    self.services.source_versions.clone(),
                    call_key,
                    cancel.clone(),
                    deadline,
                )
                .await?;
                HostResponse::ModelGenerate(recorded.receipt().clone())
            }
            HostRequest::StateRead(request) => {
                let receipt = migration::read_state(
                    self.context.store(),
                    self.context.admission(),
                    self.context.lease(),
                    self.context.node(),
                    request,
                    &self.services.state_limits,
                )
                .await?;
                if let Some(value) = &receipt.value {
                    self.context
                        .budget()
                        .charge(BudgetDimension::Bytes, value.value.len() as u64)
                        .map_err(|error| budget_error(error.dimension))?;
                }
                HostResponse::StateRead(receipt.value)
            }
            HostRequest::StateWrite(request) => {
                self.context
                    .budget()
                    .charge(BudgetDimension::Bytes, request.value.len() as u64)
                    .map_err(|error| budget_error(error.dimension))?;
                let digest = hash(&(
                    self.context.admission().invocation().world.clone(),
                    self.context.lease().invocation(),
                    self.context.node(),
                    call_key,
                ))?;
                let value = migration::write_state(
                    self.context.store(),
                    self.context.admission(),
                    self.context.lease(),
                    self.context.node(),
                    request,
                    commit_id("state", &digest)?,
                    &self.services.state_limits,
                )
                .await?;
                HostResponse::StateWrite(value.value)
            }
            HostRequest::Clock => {
                if !self
                    .context
                    .admission()
                    .impact()
                    .effects
                    .contains(&Effect::ClockRead)
                {
                    return Err(HostCallFailure::new(
                        HostFailure::Authorization(
                            world_protocol::authorization::AuthorizationFailure::InsufficientScope,
                        ),
                        FailureStage::Admission,
                    ));
                }
                let timestamp = self
                    .context
                    .store()
                    .snapshot(
                        self.context.admission().invocation().world.clone(),
                        |snapshot| Box::pin(async move { snapshot.now().await }),
                    )
                    .await?;
                HostResponse::Clock(timestamp)
            }
            HostRequest::Log(record) => {
                if record.code.is_empty()
                    || record.code.len() > 128
                    || !record
                        .code
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                    || record.message.len() + record.code.len() > process::MAX_LOG_BYTES
                {
                    return Err(invalid("log"));
                }
                self.context
                    .budget()
                    .charge(
                        BudgetDimension::Bytes,
                        (record.code.len() + record.message.len()) as u64,
                    )
                    .map_err(|error| budget_error(error.dimension))?;
                // Guest text and identifiers can contain secrets; trace only safe enum/count summaries.
                platform::trace::runtime_trace(
                    "world.plugin.log",
                    || serde_json::json!({"level": record.level, "bytes": record.code.len() + record.message.len()}),
                );
                HostResponse::Log
            }
        };
        self.context.check_current().await?;
        let required = self.required_access(&request).await?;
        self.require_grants(required).await?;
        self.context.check_output(1).await?;
        if !committed {
            self.context
                .budget()
                .check()
                .map_err(|error| budget_error(error.dimension))?;
            if cancel.is_cancelled() || self.context.pipeline().is_cancelled() {
                return Err(HostCallFailure::new(
                    HostFailure::Cancelled,
                    FailureStage::Execute,
                ));
            }
            if Instant::now() >= deadline {
                return Err(budget_error(BudgetDimension::Deadline));
            }
        }
        Ok(response)
    }

    async fn require_grants(&self, required: Vec<RequestedAccess>) -> Result<(), HostCallFailure> {
        let implementation = self
            .context
            .lease()
            .graph()
            .node(self.context.node())
            .map_err(|failure| {
                HostCallFailure::new(HostFailure::Binding(failure), FailureStage::Admission)
            })?
            .implementation
            .clone();
        self.context
            .store()
            .snapshot(
                self.context.admission().invocation().world.clone(),
                move |snapshot| {
                    Box::pin(async move {
                        crate::extensions::package::require_grants_read(
                            snapshot,
                            &implementation,
                            &required,
                        )
                        .await
                    })
                },
            )
            .await?;
        Ok(())
    }

    async fn required_access(
        &self,
        request: &HostRequest,
    ) -> Result<Vec<RequestedAccess>, HostCallFailure> {
        Ok(match request {
            HostRequest::SourceRead(plan) => {
                self.services
                    .source
                    .as_ref()
                    .ok_or_else(|| missing("source.read"))?
                    .required_read_access(plan, self.context.admission())
                    .await?
            }
            HostRequest::WorldRead(request) => {
                if request.world != self.context.admission().invocation().world {
                    return Err(invalid("world"));
                }
                let request = request.clone();
                let admission = self.context.admission().clone();
                self.context
                    .store()
                    .snapshot(request.world.clone(), move |snapshot| {
                        Box::pin(async move {
                            let scope = management_scope(snapshot).await?;
                            let impact = crate::query::impact(snapshot, &request, &scope).await?;
                            admission.require_access(&impact)?;
                            let fields = impact
                                .access
                                .iter()
                                .flat_map(|access| {
                                    access.fields.iter().map(|field| field.id.clone())
                                })
                                .collect::<std::collections::BTreeSet<_>>()
                                .into_iter()
                                .collect();
                            Ok::<_, HostCallFailure>(vec![RequestedAccess::WorldRead { fields }])
                        })
                    })
                    .await?
            }
            HostRequest::ModelGenerate(_) => vec![RequestedAccess::ModelGeneration],
            HostRequest::Clock => vec![RequestedAccess::Clock],
            HostRequest::StateRead(_) | HostRequest::StateWrite(_) | HostRequest::Log(_) => {
                Vec::new()
            }
        })
    }

    async fn world_read(
        &self,
        request: &world_protocol::query::QueryRequest,
        call_key: &str,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<world_protocol::query::QueryPage, HostCallFailure> {
        let world = request.world.clone();
        let scope = self
            .context
            .store()
            .snapshot(world.clone(), |snapshot| {
                Box::pin(management_scope(snapshot))
            })
            .await?;
        let identity = hash(&(
            &world,
            self.context.lease().invocation(),
            self.context.node(),
            call_key,
        ))?;
        let commit = commit_id("query", &identity)?;
        let input_digest = hash(&(request,))?;
        let recovered = self
            .context
            .store()
            .read_commit_optional::<world_protocol::query::QueryPage>(
                &world,
                &commit,
                &input_digest,
            )
            .await?;
        let page = if let Some(committed) = recovered {
            committed.value
        } else {
            let prepared = crate::query::execute(
                self.context.store(),
                &self.services.content,
                Some(&self.services.sources),
                self.context.admission(),
                request,
                &scope,
                self.context.pipeline(),
                self.context.budget(),
                cancel,
                deadline,
            )
            .await?;
            self.context.check_current().await?;
            let required = self
                .required_access(&HostRequest::WorldRead(request.clone()))
                .await?;
            self.require_grants(required).await?;
            if cancel.is_cancelled() || self.context.pipeline().is_cancelled() {
                return Err(HostCallFailure::new(
                    HostFailure::Cancelled,
                    FailureStage::Commit,
                ));
            }
            if Instant::now() >= deadline {
                return Err(budget_error(BudgetDimension::Deadline));
            }
            let (storage_epoch, fences) = self
                .context
                .store()
                .snapshot(world.clone(), |snapshot| {
                    Box::pin(async move { crate::owner::writer_fences(snapshot, &["query"]).await })
                })
                .await?;
            let batch = CommitRequest {
                world: world.clone(),
                commit_id: commit,
                input_digest,
                storage_epoch,
                fences,
                watch_basis: Vec::new(),
            }
            .prepare()?;
            let admission = self.context.admission().clone();
            self.context
                .store()
                .transact(batch, move |tx| {
                    Box::pin(
                        async move { crate::query::commit_read(tx, &admission, prepared).await },
                    )
                })
                .await
                .map_err(HostCallFailure::from)?
                .value
        };
        crate::query::recheck_page(
            self.context.store(),
            &self.services.content,
            self.context.admission(),
            request,
            &scope,
            &page,
            self.context.budget(),
            cancel,
        )
        .await?;
        Ok(page)
    }
}
async fn management_scope(
    snapshot: &crate::store::WorldSnapshot<'_>,
) -> Result<ScopeId, HostCallFailure> {
    let row = snapshot.query_opt("SELECT management_scope_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 AND status='ready'",
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()]).await?
        .ok_or_else(|| crate::store::StoreError::new(world_protocol::commit::CommitFailure::Closed, FailureStage::Read))?;
    ScopeId::try_new(row.get::<_, String>("management_scope_id")).map_err(|cause| {
        crate::store::StoreError::caused_by(
            world_protocol::commit::CommitFailure::InternalFault,
            FailureStage::Read,
            cause,
        )
        .into()
    })
}
fn hash(value: &impl serde::Serialize) -> Result<Digest, HostCallFailure> {
    let bytes = serde_json::to_vec(value).map_err(|cause| {
        HostCallFailure::caused_by(HostFailure::InternalFault, FailureStage::Validate, cause)
    })?;
    Ok(Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("SHA256 digest"))
}
fn commit_id(kind: &str, digest: &Digest) -> Result<CommitId, HostCallFailure> {
    CommitId::try_new(format!("host-{kind}-{}", &digest.as_str()[7..])).map_err(|cause| {
        HostCallFailure::caused_by(HostFailure::InternalFault, FailureStage::Prepare, cause)
    })
}
fn budget_error(dimension: BudgetDimension) -> HostCallFailure {
    HostCallFailure::new(
        HostFailure::BudgetExceeded { dimension },
        FailureStage::Execute,
    )
}
fn invalid(field: &str) -> HostCallFailure {
    HostCallFailure::new(
        HostFailure::Input(InputFailure::InvalidValue {
            field: FieldPath(vec![field.into()]),
        }),
        FailureStage::Validate,
    )
}
fn missing(port: &str) -> HostCallFailure {
    HostCallFailure::new(
        HostFailure::Binding(BindingFailure::MissingPort {
            node_id: NodeId::try_new("host").expect("constant node"),
            port: port.into(),
        }),
        FailureStage::Prepare,
    )
}
