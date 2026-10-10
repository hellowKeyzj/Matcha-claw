use crate::{GraphRunId, OrganizationStore, RunStartGate, StoreFault, TeamId};

impl OrganizationStore {
    pub(crate) fn begin_design(
        &mut self,
        team_id: &TeamId,
        run_id: &GraphRunId,
        epoch: String,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.design_run_mut(run_id).ok_or(StoreFault::InvalidFacts)?;
            if run.team() != team_id || matches!(run.start_gate(), RunStartGate::Started) {
                return Err(StoreFault::InvalidFacts);
            }
            if matches!(run.start_gate(), RunStartGate::Designing { design_epoch, .. } if design_epoch == &epoch) {
                return Ok(());
            }
            run.start_gate = RunStartGate::Designing { design_epoch: epoch, prompt_generation: None };
            Ok(())
        })
    }

    pub(crate) fn design_patch(
        &mut self,
        team_id: &TeamId,
        epoch: &str,
        generation: Option<&str>,
        version: &str,
        draft: crate::TeamGraphPatchDraft,
    ) -> Result<(), StoreFault> {
        let run_id = draft.run_id.clone();
        let mut replayed = false;
        let result = self.transact(|facts| {
            crate::application::design::guard(facts, team_id, &run_id, epoch, generation, None)?;
            let run = facts.run(&run_id).ok_or(StoreFault::InvalidFacts)?;
            let command = draft.command(run.graph().definition())?;
            let existing = facts
                .events()
                .command_by_idempotency(command.run_id(), command.idempotency_key());
            if let Some(existing) = existing {
                if existing.command().command_id() != command.command_id()
                    || existing.command().payload() != command.payload()
                {
                    return Err(StoreFault::EventLedger(
                        crate::RecordCommandError::IdempotencyConflict,
                    ));
                }
                replayed = true;
                return Ok(());
            }
            crate::application::design::guard(
                facts,
                team_id,
                &run_id,
                epoch,
                generation,
                Some(version),
            )?;
            let patch = draft.resolve(run.graph().definition(), run.runtime().map_or(&[], |runtime| runtime.bindings()))?;
            platform::trace::runtime_trace("runtime.team_run.graph_write.request", || serde_json::json!({
                "operation": "design_patch", "runHash": platform::trace::identifier_hash(run_id.as_str()),
                "expectedVersionHash": platform::trace::identifier_hash(version),
                "patch": crate::trace::patch_edges(patch.operations()),
            }));
            facts.team_graph_patch(command, &patch)?;
            if let Some(generation) = generation {
                let run = facts
                    .design_run_mut(&run_id)
                    .ok_or(StoreFault::InvalidFacts)?;
                if let RunStartGate::Designing {
                    prompt_generation, ..
                } = &mut run.start_gate
                {
                    *prompt_generation = Some(generation.to_owned());
                }
            }
            Ok(())
        });
        crate::trace::graph_write_result(self.facts(), &run_id, "design_patch", result.as_ref().map(|()| replayed));
        result
    }

    pub(crate) fn register_design_prompt(
        &mut self,
        run_id: &GraphRunId,
        generation: String,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts
                .design_run_mut(run_id)
                .ok_or(StoreFault::InvalidFacts)?;
            let epoch = match run.start_gate() {
                RunStartGate::Designing { design_epoch, .. } => design_epoch.clone(),
                _ => return Err(StoreFault::InvalidFacts),
            };
            run.start_gate = RunStartGate::Designing {
                design_epoch: epoch,
                prompt_generation: Some(generation),
            };
            Ok(())
        })
    }
}

pub(crate) fn invalidate_graph_design(run: &mut crate::GraphRunFacts) {
    if let RunStartGate::Designing { design_epoch, .. } = run.start_gate() {
        run.start_gate = RunStartGate::Designing {
            design_epoch: design_epoch.clone(),
            prompt_generation: None,
        };
    }
}
