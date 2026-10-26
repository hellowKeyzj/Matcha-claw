use std::sync::Arc;

use foundation::pipeline::PipelineContext;
use world_protocol::{ids::NodeId, time::Timestamp};

use super::{CallBudget, CurrentFailure, InvocationLease, check_current};
use crate::{
    authorization::{self, Admission, AuthError},
    store::WorldStore,
};

/// Shared private call facts; neither a second run owner nor an authority root.
#[derive(Clone)]
pub(crate) struct InvocationContext {
    store: Arc<WorldStore>,
    admission: Admission,
    lease: Arc<InvocationLease>,
    node: NodeId,
    pipeline: PipelineContext,
    budget: CallBudget,
}

impl InvocationContext {
    pub fn new(
        store: Arc<WorldStore>,
        admission: Admission,
        lease: Arc<InvocationLease>,
        node: NodeId,
        pipeline: PipelineContext,
        budget: CallBudget,
    ) -> Result<Self, CurrentFailure> {
        if lease.ledger(&node).is_none()
            || admission.invocation().id != *lease.invocation()
            || admission.invocation().world != lease.graph().lock().world
        {
            return Err(AuthError::Denied(
                world_protocol::authorization::AuthorizationFailure::InsufficientScope,
            )
            .into());
        }
        Ok(Self {
            store,
            admission,
            lease,
            node,
            pipeline,
            budget,
        })
    }
    pub fn with_node(&self, node: NodeId) -> Result<Self, CurrentFailure> {
        Self::new(
            self.store.clone(),
            self.admission.clone(),
            self.lease.clone(),
            node,
            self.pipeline.clone(),
            self.budget.clone(),
        )
    }
    pub(super) fn with_budget(&self, budget: CallBudget) -> Self {
        Self {
            budget,
            ..self.clone()
        }
    }
    pub(crate) fn same_call(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.store, &other.store)
            && Arc::ptr_eq(&self.lease, &other.lease)
            && self.node == other.node
            && self.admission.invocation() == other.admission.invocation()
            && self.admission.restart_identity() == other.admission.restart_identity()
            && self.admission.decision() == other.admission.decision()
            && self.admission.impact() == other.admission.impact()
            && self.admission.approval() == other.admission.approval()
            && self.pipeline.run_id() == other.pipeline.run_id()
            && self.pipeline.cancellation() == other.pipeline.cancellation()
            && Arc::ptr_eq(&self.pipeline.artifacts(), &other.pipeline.artifacts())
            && Arc::ptr_eq(&self.pipeline.checkpoints(), &other.pipeline.checkpoints())
            && self.budget.same_scope(&other.budget)
    }
    pub fn store(&self) -> &Arc<WorldStore> {
        &self.store
    }
    pub fn admission(&self) -> &Admission {
        &self.admission
    }
    pub fn lease(&self) -> &Arc<InvocationLease> {
        &self.lease
    }
    pub fn node(&self) -> &NodeId {
        &self.node
    }
    pub fn pipeline(&self) -> &PipelineContext {
        &self.pipeline
    }
    pub fn budget(&self) -> &CallBudget {
        &self.budget
    }

    pub async fn check_current(&self) -> Result<(), CurrentFailure> {
        check_current(&self.store, &self.admission, &self.lease, &self.node).await
    }

    pub async fn check_output(&self, delivered: u64) -> Result<(), AuthError> {
        let admission = self.admission.clone();
        self.store
            .snapshot(admission.invocation().world.clone(), move |snapshot| {
                Box::pin(async move {
                    let at = Timestamp::try_new(chrono::Utc::now().to_rfc3339()).map_err(|_| {
                        AuthError::Denied(
                            world_protocol::authorization::AuthorizationFailure::InternalFault,
                        )
                    })?;
                    authorization::check_admitted_output_read(
                        snapshot,
                        &admission,
                        admission.impact(),
                        delivered,
                        &at,
                    )
                    .await
                    .map(|_| ())
                })
            })
            .await
    }
}
