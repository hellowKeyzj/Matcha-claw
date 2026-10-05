use crate::{GraphRunId, OrganizationStore, RunStartGate, StoreFault, TeamId};

impl OrganizationStore {
    pub(crate) fn begin_design(
        &mut self,
        team_id: &TeamId,
        run_id: &GraphRunId,
        epoch: String,
        proposal_id: Option<&str>,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.design_run_mut(run_id).ok_or(StoreFault::InvalidFacts)?;
            if run.team() != team_id || matches!(run.start_gate(), RunStartGate::Started) {
                return Err(StoreFault::InvalidFacts);
            }
            if matches!(run.start_gate(), RunStartGate::Designing { design_epoch, .. } if design_epoch == &epoch) {
                return Ok(());
            }
            if let Some(proposal_id) = proposal_id {
                if !matches!(run.start_gate(), RunStartGate::DesignProposalPending { proposal_id: current, .. } if current == proposal_id) {
                    return Err(StoreFault::InvalidFacts);
                }
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
        self.transact(|facts| {
            let run_id = draft.run_id.clone();
            crate::application::design::guard(facts, team_id, &run_id, epoch, generation, None)?;
            let run = facts.run(&run_id).ok_or(StoreFault::InvalidFacts)?;
            let (command, patch) = draft
                .resolve(run.graph().definition())
                .map_err(|_| StoreFault::InvalidFacts)?;
            let existing = facts
                .events()
                .command_by_idempotency(command.run_id(), command.idempotency_key());
            if let Some(existing) = existing {
                if existing.command().command_id() != command.command_id()
                    || existing.command().payload() != command.payload()
                {
                    return Err(StoreFault::InvalidFacts);
                }
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
            facts
                .team_graph_patch(command, &patch)
                .map_err(StoreFault::EventLedger)?;
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
        })
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
                RunStartGate::Designing { design_epoch, .. }
                | RunStartGate::DesignProposalPending { design_epoch, .. } => design_epoch.clone(),
                _ => return Err(StoreFault::InvalidFacts),
            };
            run.start_gate = RunStartGate::Designing {
                design_epoch: epoch,
                prompt_generation: Some(generation),
            };
            Ok(())
        })
    }

    pub(crate) fn record_design_ready(
        &mut self,
        run_id: &GraphRunId,
        generation: String,
        summary: String,
        delivery: String,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
            let epoch = match run.start_gate() {
                RunStartGate::Designing {
                    design_epoch,
                    prompt_generation: Some(current),
                } if current == &generation => design_epoch.clone(),
                _ => return Err(StoreFault::InvalidFacts),
            };
            crate::application::design::validate_graph(facts, run)?;
            let graph_version = crate::store::codec::graph_version(run.graph().definition())?;
            let run = facts
                .design_run_mut(run_id)
                .ok_or(StoreFault::InvalidFacts)?;
            run.start_gate = RunStartGate::DesignProposalPending {
                design_epoch: epoch,
                prompt_generation: generation.clone(),
                graph_version,
                proposal_id: generation,
                summary,
                source_delivery_id: delivery,
            };
            Ok(())
        })
    }
}

pub(crate) fn invalidate_graph_design(run: &mut crate::GraphRunFacts) {
    if let RunStartGate::DesignProposalPending { design_epoch, .. }
    | RunStartGate::Designing { design_epoch, .. } = run.start_gate()
    {
        run.start_gate = RunStartGate::Designing {
            design_epoch: design_epoch.clone(),
            prompt_generation: None,
        };
    }
}
