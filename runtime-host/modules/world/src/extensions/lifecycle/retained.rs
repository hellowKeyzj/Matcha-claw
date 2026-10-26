use world_protocol::lifecycle::{
    ResourceFailureReason, ResourceFailureStage, ResourcePartFailure as Part,
    ResourceStage as Stage, RetainedResource,
};

use crate::extensions::invocation::{LedgerSnapshot, ResourceKind, ResourceStage, ResourceState};

pub(crate) fn retained_resources(snapshot: &LedgerSnapshot) -> Vec<RetainedResource> {
    snapshot
        .resources
        .iter()
        .map(|resource| {
            let reason = match (&resource.failure, resource.state, resource.spec.kind) {
                (Some(failure), _, _) if failure.code.ends_with("deadline") => {
                    ResourceFailureReason::Timeout
                }
                (Some(failure), _, _) if failure.stage == ResourceStage::TaskJoin => {
                    ResourceFailureReason::JoinFailed
                }
                (Some(failure), _, _)
                    if matches!(
                        failure.stage,
                        ResourceStage::Stop
                            | ResourceStage::Shutdown
                            | ResourceStage::SupervisorJoin
                    ) =>
                {
                    ResourceFailureReason::ProcessExitUnconfirmed
                }
                (_, ResourceState::Acquiring, _) => ResourceFailureReason::AcquisitionClosed,
                (_, _, ResourceKind::Dependency) => ResourceFailureReason::DependencyMissing,
                (_, _, ResourceKind::Store) => ResourceFailureReason::EngineNotStopped,
                (_, _, ResourceKind::Process) => ResourceFailureReason::ProcessExitUnconfirmed,
                _ => ResourceFailureReason::CleanupFailed,
            };
            let stage = match resource.state {
                ResourceState::Acquiring => Stage::Acquiring,
                ResourceState::Active | ResourceState::CancelRequested => Stage::Running,
                ResourceState::Releasing | ResourceState::WaitingForChildren => Stage::Joining,
                ResourceState::Retained => Stage::CleanupFailed,
            };
            let mut parts = Vec::new();
            if let Some(failure) = &resource.failure {
                parts.push(Part {
                    kind: resource.spec.kind,
                    name: "resource".into(),
                    stage: failure_stage(failure.stage),
                    code: failure.code.into(),
                    message: failure.message.clone(),
                });
                parts.extend(failure.remaining.iter().map(|part| Part {
                    kind: part.kind,
                    name: part.name.clone(),
                    stage: failure_stage(part.stage),
                    code: part.code.into(),
                    message: part.message.clone(),
                }));
            }
            RetainedResource {
                parts,
                token: resource.spec.token.clone(),
                generation_id: snapshot.generation.clone(),
                invocation_id: resource.spec.invocation.clone(),
                acquisition_id: resource.acquisition.clone(),
                kind: resource.spec.kind,
                stage,
                reason,
            }
        })
        .collect()
}

fn failure_stage(stage: ResourceStage) -> ResourceFailureStage {
    match stage {
        ResourceStage::Acquisition => ResourceFailureStage::Acquisition,
        ResourceStage::Admission => ResourceFailureStage::Admission,
        ResourceStage::Cancel => ResourceFailureStage::Cancel,
        ResourceStage::Stop => ResourceFailureStage::Stop,
        ResourceStage::Shutdown => ResourceFailureStage::Shutdown,
        ResourceStage::SupervisorJoin => ResourceFailureStage::SupervisorJoin,
        ResourceStage::TaskJoin => ResourceFailureStage::TaskJoin,
        ResourceStage::MaterialCleanup => ResourceFailureStage::MaterialCleanup,
        ResourceStage::Cleanup => ResourceFailureStage::Cleanup,
        ResourceStage::Completion => ResourceFailureStage::Completion,
    }
}
