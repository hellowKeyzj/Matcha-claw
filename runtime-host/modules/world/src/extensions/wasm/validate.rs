use world_protocol::{
    ids::WorldRef,
    slots::{SlotRequest, SlotResponse},
};

use super::WasmError;
use crate::extensions::invocation::InvocationContext;

pub(super) async fn request(
    context: &InvocationContext,
    request: &SlotRequest,
) -> Result<(), WasmError> {
    context.check_current().await?;
    let expected = &context.admission().invocation().world;
    match request {
        SlotRequest::Connector(value) => world(expected, &value.binding.world)?,
        SlotRequest::ConnectorDiscover(value) => {
            if value.resource.is_empty() || value.resource.len() > 256 {
                return Err(WasmError::InvalidData { field: "resource" });
            }
        }
        SlotRequest::Identity(value) => {
            world(expected, &value.key.world)?;
            world(expected, &value.type_ref.world)?;
        }
        SlotRequest::Schema(value) => world(expected, &value.world)?,
        SlotRequest::SchemaKind(value) => {
            world(expected, &value.definition.reference.world)?;
            if let Some(previous) = &value.previous {
                world(expected, &previous.reference.world)?;
            }
            for definition in &value.definitions {
                world(expected, &definition.reference.world)?;
            }
            for scope in &value.scopes {
                world(expected, &scope.world)?;
            }
        }
        SlotRequest::Resolver(value) => world(expected, &value.query.world)?,
        SlotRequest::Projection(value) => world(expected, &value.world)?,
        SlotRequest::Provenance(value) => {
            for assertion in &value.assertions {
                world(expected, &assertion.world)?;
            }
            for evidence in &value.evidence {
                world(expected, &evidence.world)?;
            }
            for support in &value.supports {
                world(expected, &support.reference.world)?;
            }
            for watch in &value.watches {
                world(expected, &watch.world)?;
            }
        }
        SlotRequest::Compiler(value) => world(expected, &value.ir.world)?,
        SlotRequest::Policy(value) => world(expected, &value.world)?,
        SlotRequest::Action(value) => {
            world(expected, &value.proposal.request.world)?;
            world(expected, &value.contract.reference.world)?;
        }
        SlotRequest::Reconcile(value) => world(expected, &value.world)?,
        SlotRequest::Abstraction(value) => world(expected, &value.world)?,
        SlotRequest::Evaluation(value) => {
            world(expected, &value.world)?;
            for query in &value.queries {
                world(expected, &query.page.receipt.world)?;
            }
            // This execution path is an ordinary guest, never the protected verifier.
            return Err(WasmError::EntrypointUnsupported);
        }
        SlotRequest::Context(value) => {
            world(expected, &value.world)?;
            world(expected, &value.task.world)?;
            world(expected, &value.query.world)?;
        }
        SlotRequest::AgentBridge(value) => world(expected, &value.peer.world)?,
        SlotRequest::Storage(value) => world(expected, &value.world)?,
    }
    Ok(())
}

pub(super) async fn response(
    context: &InvocationContext,
    request: &SlotRequest,
    result: &SlotResponse,
) -> Result<(), WasmError> {
    let expected = &context.admission().invocation().world;
    match (request, result) {
        (SlotRequest::Projection(request), SlotResponse::Projection(value)) => {
            let admission = context.admission().clone();
            let request = request.clone();
            let value = value.clone();
            context
                .store()
                .snapshot(expected.clone(), move |snapshot| {
                    Box::pin(async move {
                        crate::facts::assertions::validate_projection_snapshot(
                            snapshot, &admission, &request, &value,
                        )
                        .await
                        .map_err(WasmError::Proposal)?;
                        Ok::<_, WasmError>(())
                    })
                })
                .await?;
        }
        (SlotRequest::Reconcile(request), SlotResponse::Reconcile(value)) => {
            let admission = context.admission().clone();
            let request = request.clone();
            let value = value.clone();
            context
                .store()
                .snapshot(expected.clone(), move |snapshot| {
                    Box::pin(async move {
                        crate::facts::assertions::validate_reconciliation_snapshot(
                            snapshot, &admission, &request, &value,
                        )
                        .await
                        .map_err(WasmError::Proposal)?;
                        Ok::<_, WasmError>(())
                    })
                })
                .await?;
        }
        (SlotRequest::Schema(request), SlotResponse::Schema(value)) => {
            world(&request.world, &value.world)?
        }
        (SlotRequest::SchemaKind(request), SlotResponse::SchemaKind(value)) => {
            if &value.contract != request.contract() {
                return Err(WasmError::InvalidData { field: "kind.contract" });
            }
            use world_protocol::definitions::{KindOperation, KindResult};
            match (&request.operation, &value.result) {
                (KindOperation::Validate, KindResult::Validated)
                | (KindOperation::Index, KindResult::Indexed { .. })
                | (KindOperation::Lifecycle, KindResult::LifecycleChecked) => {}
                (KindOperation::Lower, KindResult::Lowered { body }) => {
                    if matches!(body, world_protocol::definitions::DefinitionBody::Extension(_)) {
                        return Err(WasmError::InvalidData { field: "kind.lower" });
                    }
                }
                (KindOperation::Migrate, KindResult::Migrated { definition })
                | (KindOperation::Reducer { .. }, KindResult::Reduced { definition }) => {
                    world(expected, &definition.reference.world)?;
                }
                _ => return Err(WasmError::InvalidData { field: "kind.result" }),
            }
            if let KindResult::Indexed { dependencies } = &value.result {
                for dependency in dependencies {
                    world(expected, &dependency.world)?;
                }
            }
        }
        (SlotRequest::Compiler(request), SlotResponse::Compiler(value)) => {
            world(&request.ir.world, &value.ir.world)?
        }
        (SlotRequest::Abstraction(request), SlotResponse::Abstraction(value)) => {
            world(&request.world, &value.world)?
        }
        (SlotRequest::Context(request), SlotResponse::Context(value)) => {
            world(&request.world, &value.view.world)?;
            world(&request.world, &value.receipt.world)?;
        }
        (SlotRequest::Evaluation(_), SlotResponse::Evaluation(value)) => {
            for evidence in &value.evidence {
                world(expected, &evidence.world)?;
            }
            for pair in [
                (value.evidence_satisfied, value.evidence_required),
                (value.conflicts_detected, value.conflicts_present),
            ] {
                if !matches!(pair, (None, None))
                    && !matches!(pair, (Some(numerator), Some(denominator)) if numerator <= denominator)
                {
                    return Err(WasmError::InvalidData {
                        field: "oracle.measurements",
                    });
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn world(expected: &WorldRef, actual: &WorldRef) -> Result<(), WasmError> {
    if actual != expected {
        return Err(WasmError::LeaseMismatch);
    }
    Ok(())
}
