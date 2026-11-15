use crate::{
    GraphEvent, GraphPatch, GraphPatchOperation, GraphRunLifecycleState, OrganizationStore,
    ReworkContinueRequest, RunStartGate, StoreFault,
    run::event::{CommandPayload, OpaqueId, RunCommand},
};

use super::{RuntimeGraphError, codec::graph_version};

impl OrganizationStore {
    pub(crate) fn continue_rework(
        &mut self,
        request: &ReworkContinueRequest,
        continued_at: u64,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts
                .run(&request.run_id)
                .ok_or(StoreFault::RuntimeGraph(RuntimeGraphError::UnknownRun))?;
            if run.team() != &request.team_id {
                return Err(StoreFault::RuntimeGraph(RuntimeGraphError::TeamMismatch));
            }
            let command = RunCommand::new(
                OpaqueId::try_new(request.run_id.as_str()).map_err(StoreFault::GraphPatchInput)?,
                request.command_id.clone(),
                request.idempotency_key.clone(),
                CommandPayload::ReworkContinue {
                    batch_id: request.batch_id.get(),
                    source_node_id: request.source_node_id.as_str().to_owned(),
                    source_port: request.source_port.clone(),
                    source_node_execution_id: request.source_node_execution_id.as_str().to_owned(),
                    max_reworks: request.max_reworks,
                    expected_graph_version: request.expected_graph_version.clone(),
                },
                continued_at,
            );
            if facts
                .events()
                .replay(&command)
                .map_err(StoreFault::EventLedger)?
                .is_some()
            {
                return Ok(());
            }
            if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || !matches!(run.start_gate(), RunStartGate::Started)
                || facts
                    .team(&request.team_id)
                    .is_none_or(|team| team.tombstoned())
            {
                return Err(StoreFault::RuntimeGraph(RuntimeGraphError::RunInactive));
            }
            if graph_version(run.graph().definition())? != request.expected_graph_version {
                return Err(StoreFault::RuntimeGraph(
                    RuntimeGraphError::StaleGraphVersion,
                ));
            }
            let source = run.graph().current_attempt(&request.source_node_id).ok_or(
                StoreFault::RuntimeGraph(RuntimeGraphError::ExecutionInactive),
            )?;
            if source.fence().node_execution_id() != &request.source_node_execution_id
                || source.batch_id() != request.batch_id
            {
                return Err(StoreFault::RuntimeGraph(
                    RuntimeGraphError::ExecutionInactive,
                ));
            }
            let source_fence = source.fence().clone();
            let patch = GraphPatch::new(
                run.graph().definition().graph_id(),
                run.graph().definition().workflow_plan_id(),
                vec![GraphPatchOperation::SetReworkLimit {
                    source_node_id: request.source_node_id.clone(),
                    source_port: request.source_port.clone(),
                    max_reworks: request.max_reworks,
                }],
            )
            .map_err(StoreFault::GraphPatch)?;
            facts.apply_graph_patch(&request.run_id, &patch, continued_at)?;
            facts.apply_graph_event(
                &request.run_id,
                GraphEvent::ContinueRework {
                    source_node_id: request.source_node_id.clone(),
                    source_port: request.source_port.clone(),
                    batch_id: request.batch_id,
                    source_fence,
                    max_reworks: request.max_reworks,
                    continued_at,
                },
            )?;
            facts.accept_run_command(command)?;
            Ok(())
        })
    }
}
