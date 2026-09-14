use matcha_agent::peer::TerminalReceiptReadError;
use organization::{
    ActivityClaim, ActivityFailure, ActivityId, ActivityKind, ActivityPhase,
    ActivityRegistrationOutcome, ActivityRequest, ActivitySettlement, ActivitySettlementOutcome,
    BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId, DeliveryPhase, DeliveryReceipt,
    DeliveryRejection, GraphDefinition, GraphRunFacts, GraphRunId, GraphRunPurgeOutcome,
    GraphState, MatchaDeliveryCorrelation, MatchaTerminalReceiptTarget, NativeRunReceiptReference,
    NativeTerminalStatus, NodeDefinition, NodeId, OrganizationStore, ResumeOutcome,
    RoleAbortOutcome, RoleId, SettleCancellationOutcome, StoreFault, TeamDecisionCommand,
    TeamDecisionReceipt, TeamGraphContextQuery, TeamGraphContextResult, TeamId, TeamNodeEvent,
    TeamNodeEventOutcome, TeamRunProjection, TeamRunQuery, TeamRunQueryOutcome,
    TerminalObservationOutcome, TombstoneOutcome, TriggerFireRequest, TriggerRegistration,
    plan_terminal_observations, query_team_run,
    run::lifecycle::GraphRunLifecycleState,
    run::scheduler::{NodePromptRetryDueQuery, NodePromptRetryDueQueryOutcome},
};

use super::session::RuntimeSessionError;
use crate::runtime_driver::{
    ActivityExecutionRequest, ActivityExecutionRequestError, AgentTaskActivity,
};

/// The only Host-composed TeamRun semantic seam. It reads the existing Organization durable owner
/// and deliberately has no materialization or recovery provider attached.
pub(crate) struct TeamRunOwner;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamRunActivityTarget {
    OpenClaw { run_id: GraphRunId },
    Matcha { run_id: GraphRunId },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamRunActivityError {
    InvalidPrompt,
    InvalidBinding,
    SessionMismatch,
    Store(StoreFault),
}

pub(crate) enum TeamRunActivityStart {
    Claimed {
        claim: ActivityClaim,
        request: ActivityExecutionRequest,
    },
    Immediate(TeamRunActivityOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamRunActivityOutcome {
    Dispatched(TeamRunCommandOutcome),
    AlreadyClaimed(TeamRunCommandOutcome),
    AwaitingRetry(TeamRunCommandOutcome),
    Terminal(TeamRunCommandOutcome),
    OutcomeUnknown(TeamRunCommandOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MatchaTerminalObservationError {
    Correlation,
    Receipt(RuntimeSessionError<TerminalReceiptReadError>),
    Store(StoreFault),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MatchaTerminalObservationOutcome {
    Pending,
    NotFound,
    Observed(TeamRunTerminalObservationOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamNodePromptSettledResult {
    Recorded(GraphRunId),
    Replayed(GraphRunId),
    NotFound,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamNodeTerminalResult {
    Recorded,
    Replayed,
}

impl TeamRunOwner {
    pub(crate) const fn new() -> Self {
        Self
    }

    fn recover_activity_run(
        &self,
        store: &OrganizationStore,
        activity_id: &ActivityId,
    ) -> TeamRunCommandOutcome {
        let activity = store
            .facts()
            .activities()
            .activity(activity_id)
            .expect("activity command preserves its extant activity");
        self.recover_run(store, &activity.facts().run_id)
    }

    fn recover_run(&self, store: &OrganizationStore, run_id: &GraphRunId) -> TeamRunCommandOutcome {
        let team = store
            .facts()
            .run(run_id)
            .expect("TeamRun command preserves its extant TeamRun")
            .team()
            .clone();
        self.recover(store, TeamRunQuery::get(team, run_id.clone()))
    }

    pub(crate) fn query(
        &self,
        store: &OrganizationStore,
        query: &TeamRunQuery,
    ) -> TeamRunQueryOutcome {
        query_team_run(store.facts(), query)
    }

    /// Records only a run whose team already has a confirmed materialization receipt.
    ///
    /// The Organization transition owns this precondition, so replay remains durable and no
    /// role session or runtime receipt is fabricated by Host composition.
    pub(crate) fn create(
        &self,
        store: &mut OrganizationStore,
        run: GraphRunFacts,
        idempotency_key: &str,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        store.create_graph_run(run, idempotency_key)
    }

    pub(crate) fn run_from_team_template(
        &self,
        store: &OrganizationStore,
        team_id: &TeamId,
        run_id: GraphRunId,
        idempotency_key: &str,
        created_at: u64,
    ) -> Result<GraphRunFacts, StoreFault> {
        let team = store
            .facts()
            .team(team_id)
            .ok_or(StoreFault::InvalidFacts)?;
        let template = persisted_graph_template(store.facts(), team_id)
            .unwrap_or_else(|| default_graph_template(team_id, team.definition().name()));
        let definition = instantiate_graph_template(&template, run_id, idempotency_key)?;
        GraphRunFacts::new(
            team_id.clone(),
            team.revision(),
            GraphState::initialize(definition, created_at),
            None,
        )
        .map_err(|_| StoreFault::InvalidFacts)
    }

    pub(crate) fn create_from_team_template(
        &self,
        store: &mut OrganizationStore,
        team_id: &TeamId,
        run_id: GraphRunId,
        idempotency_key: &str,
        created_at: u64,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        let run =
            self.run_from_team_template(store, team_id, run_id, idempotency_key, created_at)?;
        self.create(store, run, idempotency_key)
    }

    /// Creates a TeamRun through the Organization workflow-plan transition.
    ///
    /// The caller supplies the already-authorized TeamSkill-derived plan. Organization owns
    /// materialization, template revision, graph instantiation, and creation idempotency.
    pub(crate) async fn create_for_team(
        &self,
        store: &mut OrganizationStore,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: &str,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<CreateGraphRunOutcome, StoreFault> {
        store.create_workflow_plan_run(
            team_id,
            run_id,
            idempotency_key,
            workflow_plan,
            source_identity,
            template_revision,
            created_at,
        )
    }

    pub(crate) fn list(
        &self,
        store: &OrganizationStore,
        team_id: &TeamId,
    ) -> Vec<TeamRunQueryOutcome> {
        store
            .facts()
            .runs()
            .filter(|run| {
                run.team() == team_id
                    && !matches!(
                        run.lifecycle().state(),
                        GraphRunLifecycleState::Tombstoned { .. }
                    )
            })
            .map(|run| {
                self.query(
                    store,
                    &TeamRunQuery::get(team_id.clone(), run.run_id().clone()),
                )
            })
            .collect()
    }

    pub(crate) fn resume(&self, store: &OrganizationStore, team_id: &TeamId) -> Vec<ResumeOutcome> {
        store.resume_graph_runs(team_id)
    }

    pub(crate) fn begin_cancellation(
        &self,
        store: &mut OrganizationStore,
        run_id: &GraphRunId,
        idempotency_key: &str,
        requested_at: u64,
    ) -> Result<BeginCancellationOutcome, StoreFault> {
        store.begin_graph_run_cancellation(run_id, idempotency_key, requested_at)
    }

    pub(crate) fn settle_cancellation(
        &self,
        store: &mut OrganizationStore,
        run_id: &GraphRunId,
        idempotency_key: &str,
        outcome: RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<SettleCancellationOutcome, StoreFault> {
        store.settle_graph_run_cancellation(run_id, idempotency_key, outcome, observed_at)
    }

    pub(crate) fn tombstone(
        &self,
        store: &mut OrganizationStore,
        run_id: &GraphRunId,
        idempotency_key: &str,
        tombstoned_at: u64,
    ) -> Result<TombstoneOutcome, StoreFault> {
        store.tombstone_graph_run(run_id, idempotency_key, tombstoned_at)
    }

    pub(crate) fn purge(
        &self,
        store: &mut OrganizationStore,
        request: organization::TeamRunPurgeRequest,
    ) -> Result<GraphRunPurgeOutcome, StoreFault> {
        organization::run::purge_team_run(store, request)
    }

    pub(crate) fn query_role_sessions(
        &self,
        store: &OrganizationStore,
        team_id: &TeamId,
    ) -> organization::TeamRoleSessionQueryOutcome {
        organization::query_team_role_sessions(store.facts(), team_id)
    }

    pub(crate) fn query_pending_approvals(
        &self,
        store: &OrganizationStore,
        team_id: &TeamId,
        run_id: &GraphRunId,
    ) -> organization::run::TeamPendingApprovalsQueryOutcome {
        organization::run::query_team_pending_approvals(store.facts(), team_id, run_id)
    }

    pub(crate) fn graph_context(
        &self,
        store: &OrganizationStore,
        query: &TeamGraphContextQuery,
    ) -> TeamGraphContextResult {
        organization::query_team_graph_context(store.facts(), query)
    }

    pub(crate) fn retry_due(
        &self,
        store: &OrganizationStore,
        query: &NodePromptRetryDueQuery,
    ) -> NodePromptRetryDueQueryOutcome {
        organization::run::query_node_prompt_retry_due(store.facts(), query)
    }

    pub(crate) fn record_decision(
        &self,
        store: &mut OrganizationStore,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, StoreFault> {
        store.record_decision(command)
    }

    pub(crate) fn record_node_event(
        &self,
        store: &mut OrganizationStore,
        command: organization::RunCommand,
        event: TeamNodeEvent,
    ) -> Result<TeamNodeEventOutcome, StoreFault> {
        store.team_node_event(command, event)
    }

    pub(crate) fn apply_graph_patch(
        &self,
        store: &mut OrganizationStore,
        patch: crate::organization::TeamGraphPatchDraft,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        let run_id = patch.run_id.clone();
        let Some(current) = store.facts().run(&run_id).cloned() else {
            return Err(StoreFault::EventLedger(
                organization::RecordCommandError::InvalidEventId,
            ));
        };
        let (command, patch) = patch
            .resolve(current.graph().definition())
            .map_err(|_| StoreFault::InvalidFacts)?;
        store.team_graph_patch(command, patch)?;
        let team = store
            .facts()
            .run(&run_id)
            .expect("graph patch preserves its extant TeamRun")
            .team()
            .clone();
        Ok(self.recover(store, TeamRunQuery::get(team, run_id)))
    }

    pub(crate) fn resolve_human_decision(
        &self,
        store: &mut OrganizationStore,
        command: organization::run::approval::HumanDecisionCommand,
    ) -> Result<organization::run::approval::HumanDecisionOutcome, StoreFault> {
        store.resolve_human_decision(command)
    }

    pub(crate) fn admit_role_chat(
        &self,
        store: &mut OrganizationStore,
        admission: organization::RoleChatAdmission,
    ) -> Result<organization::RoleChatAdmissionOutcome, StoreFault> {
        store.admit_role_chat(admission)
    }

    pub(crate) fn register_delivery(
        &self,
        store: &mut OrganizationStore,
        request: organization::DeliveryRequest,
    ) -> Result<organization::RegisterOutcome, StoreFault> {
        store.register_delivery(request)
    }

    pub(crate) fn register_activity(
        &self,
        store: &mut OrganizationStore,
        request: ActivityRequest,
    ) -> Result<ActivityRegistrationOutcome, StoreFault> {
        store.register_activity(request)
    }

    pub(crate) fn apply_control_execution_step(
        &self,
        store: &mut OrganizationStore,
        run_id: &GraphRunId,
        step: organization::ControlExecutionStep,
    ) -> Result<(), StoreFault> {
        store.apply_control_execution_step(run_id, step)
    }

    pub(crate) fn recovery(
        &self,
        store: &OrganizationStore,
        run_id: GraphRunId,
        reviews: Option<&organization::run::review::ReviewLedger>,
    ) -> Result<organization::TeamRunRecoveryPlan, organization::RecoveryQueryError> {
        organization::query_team_run_recovery(store.facts(), run_id, reviews)
    }

    pub(crate) fn recover(
        &self,
        store: &OrganizationStore,
        query: TeamRunQuery,
    ) -> TeamRunCommandOutcome {
        TeamRunCommandOutcome::from_query(self.query(store, &query))
    }

    pub(crate) fn graph_definition(
        &self,
        store: &OrganizationStore,
        team_id: &TeamId,
        run_id: &GraphRunId,
    ) -> Option<GraphDefinition> {
        let run = store.facts().run(run_id)?;
        (run.team() == team_id).then(|| run.graph().definition().clone())
    }

    pub(crate) fn replace_graph(
        &self,
        store: &mut OrganizationStore,
        command: organization::RunCommand,
        definition: GraphDefinition,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        let run_id = definition.run_id().clone();
        store.replace_team_graph(command, definition)?;
        let team = store
            .facts()
            .run(&run_id)
            .expect("graph replacement preserves its extant TeamRun")
            .team()
            .clone();
        Ok(self.recover(store, TeamRunQuery::get(team, run_id)))
    }

    pub(crate) fn fire_trigger(
        &self,
        store: &mut OrganizationStore,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<TeamRunTriggerOutcome, StoreFault> {
        let run_id = organization::GraphRunId::new(request.run_id.clone());
        let registration = store.fire_trigger(request, fired_at)?;
        let team = store
            .facts()
            .run(&run_id)
            .expect("durable trigger registration preserves its extant TeamRun")
            .team()
            .clone();
        Ok(TeamRunTriggerOutcome {
            registration,
            run: self.recover(store, TeamRunQuery::get(team, run_id)),
        })
    }

    pub(crate) fn claim_agent_activity(
        &self,
        store: &mut OrganizationStore,
        activity_id: ActivityId,
        claimed_at: u64,
    ) -> Result<TeamRunActivityStart, TeamRunActivityError> {
        let activity = store
            .facts()
            .activities()
            .activity(&activity_id)
            .cloned()
            .ok_or(TeamRunActivityError::SessionMismatch)?;
        let request = agent_task_execution_request(store, activity.facts())?;
        match activity.phase() {
            ActivityPhase::Claimed(_) | ActivityPhase::Dispatched(_) => {
                return Ok(TeamRunActivityStart::Immediate(
                    TeamRunActivityOutcome::AlreadyClaimed(
                        self.recover_activity_run(store, &activity_id),
                    ),
                ));
            }
            ActivityPhase::RetryScheduled { retry_at, .. } if *retry_at > claimed_at => {
                return Ok(TeamRunActivityStart::Immediate(
                    TeamRunActivityOutcome::AwaitingRetry(
                        self.recover_activity_run(store, &activity_id),
                    ),
                ));
            }
            phase if activity.is_terminal() => {
                return Ok(TeamRunActivityStart::Immediate(match phase {
                    ActivityPhase::OutcomeUnknown { .. } => TeamRunActivityOutcome::OutcomeUnknown(
                        self.recover_activity_run(store, &activity_id),
                    ),
                    _ => TeamRunActivityOutcome::Terminal(
                        self.recover_activity_run(store, &activity_id),
                    ),
                }));
            }
            _ => {}
        }
        let claim = store
            .claim_agent_activity(&activity_id, request.delivery_request().clone(), claimed_at)
            .map_err(TeamRunActivityError::Store)?;
        Ok(TeamRunActivityStart::Claimed { claim, request })
    }

    pub(crate) fn settle_agent_activity_dispatch(
        &self,
        store: &mut OrganizationStore,
        claim: ActivityClaim,
        outcome: crate::runtime_driver::ActivityExecutionOutcome,
    ) -> Result<TeamRunActivityOutcome, TeamRunActivityError> {
        let activity_id = claim.activity_id().clone();
        let observed_at = claim.claimed_at();
        let (delivery_receipt, activity_settlement) = match outcome {
            crate::runtime_driver::ActivityExecutionOutcome::Accepted { receipt } => (
                DeliveryReceipt::Accepted {
                    receipt,
                    matcha_correlation: matcha_activity_correlation(store, &activity_id),
                    accepted_at: observed_at,
                },
                None,
            ),
            crate::runtime_driver::ActivityExecutionOutcome::Rejected { rejection } => {
                let failure = match rejection {
                    DeliveryRejection::Permanent => ActivityFailure::Rejected,
                    DeliveryRejection::Retryable => ActivityFailure::Unavailable,
                };
                (
                    DeliveryReceipt::Rejected {
                        failure: match rejection {
                            DeliveryRejection::Permanent => {
                                organization::DeliveryFailure::PolicyRejected
                            }
                            DeliveryRejection::Retryable => {
                                organization::DeliveryFailure::Unavailable
                            }
                        },
                        observed_at,
                    },
                    Some(if failure.is_retryable() {
                        ActivitySettlement::RetryScheduled {
                            retry_at: organization::run::delivery::delivery_retry_at(observed_at),
                            observed_at,
                            failure,
                        }
                    } else {
                        ActivitySettlement::Failed {
                            failed_at: observed_at,
                            failure,
                        }
                    }),
                )
            }
            crate::runtime_driver::ActivityExecutionOutcome::Unknown => (
                DeliveryReceipt::OutcomeUnknown { observed_at },
                Some(ActivitySettlement::OutcomeUnknown { observed_at }),
            ),
        };
        let (_delivery, activity) = store
            .settle_agent_activity_dispatch(&claim, delivery_receipt, activity_settlement)
            .map_err(TeamRunActivityError::Store)?;
        Ok(match activity {
            None => {
                TeamRunActivityOutcome::Dispatched(self.recover_activity_run(store, &activity_id))
            }
            Some(ActivitySettlementOutcome::RetryScheduled) => {
                TeamRunActivityOutcome::AwaitingRetry(
                    self.recover_activity_run(store, &activity_id),
                )
            }
            Some(ActivitySettlementOutcome::Failed)
            | Some(ActivitySettlementOutcome::Completed)
            | Some(ActivitySettlementOutcome::Cancelled)
            | Some(ActivitySettlementOutcome::TerminalObserved) => {
                TeamRunActivityOutcome::Terminal(self.recover_activity_run(store, &activity_id))
            }
            Some(ActivitySettlementOutcome::OutcomeUnknown) => {
                TeamRunActivityOutcome::OutcomeUnknown(
                    self.recover_activity_run(store, &activity_id),
                )
            }
            Some(ActivitySettlementOutcome::Replayed) => TeamRunActivityOutcome::AlreadyClaimed(
                self.recover_activity_run(store, &activity_id),
            ),
        })
    }

    pub(crate) fn terminal_observation_deliveries(
        &self,
        store: &OrganizationStore,
    ) -> Vec<DeliveryId> {
        plan_terminal_observations(&store.facts().deliveries().snapshot())
            .delivery_ids()
            .to_vec()
    }

    pub(crate) fn matcha_terminal_target(
        &self,
        store: &OrganizationStore,
        delivery_id: &DeliveryId,
    ) -> Option<MatchaTerminalReceiptTarget> {
        store.matcha_terminal_target(delivery_id)
    }

    pub(crate) fn settle_node_prompt(
        &self,
        store: &mut OrganizationStore,
        session_key: &str,
        prompt_run_id: &str,
        phase: NativeTerminalStatus,
        settled_at: u64,
    ) -> Result<TeamNodePromptSettledResult, StoreFault> {
        let mut matches = store
            .facts()
            .deliveries()
            .deliveries()
            .filter_map(|delivery| {
                let correlation = match delivery.phase() {
                    DeliveryPhase::Delivered {
                        matcha_correlation: Some(correlation),
                        ..
                    } => correlation,
                    DeliveryPhase::TerminalObserved { observation } => observation.correlation(),
                    _ => return None,
                };
                let run_id = GraphRunId::new(delivery.facts().run_id.clone());
                let run = store.facts().run(&run_id)?;
                let binding = run
                    .runtime()?
                    .bindings()
                    .iter()
                    .find(|binding| binding.role().as_str() == delivery.facts().role_id)?;
                (binding.local_session().as_str() == session_key
                    && correlation.native_run_receipt().as_str() == prompt_run_id)
                    .then_some(delivery)
            })
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            return Err(StoreFault::InvalidFacts);
        }
        let Some(delivery) = matches.pop() else {
            return Ok(TeamNodePromptSettledResult::NotFound);
        };
        let run_id = GraphRunId::new(delivery.facts().run_id.clone());
        if let DeliveryPhase::TerminalObserved { observation } = delivery.phase() {
            if observation.native_terminal() != phase {
                return Err(StoreFault::InvalidFacts);
            }
            return Ok(TeamNodePromptSettledResult::Replayed(run_id));
        }
        let delivery_id = DeliveryId::new(delivery.facts().delivery_id.as_str().to_owned())
            .map_err(|_| StoreFault::InvalidFacts)?;
        let target = store
            .matcha_terminal_target(&delivery_id)
            .ok_or(StoreFault::InvalidFacts)?;
        let outcome = store.observe_matcha_terminal(target, phase, settled_at)?;
        Ok(match outcome {
            TerminalObservationOutcome::Replayed => TeamNodePromptSettledResult::Replayed(run_id),
            TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution
            | TerminalObservationOutcome::RecordedNodeCancelled => {
                TeamNodePromptSettledResult::Recorded(run_id)
            }
        })
    }

    pub(crate) fn resolve_node_terminal(
        &self,
        store: &mut OrganizationStore,
        run_id: &GraphRunId,
        node_execution_id: &organization::run::event::OpaqueId,
        event: &str,
        terminal: Option<&super::team_run_mcp::TeamNodeTerminalResolution>,
        summary: &str,
        output_port: Option<&str>,
        idempotency_key: &str,
        resolved_at: u64,
    ) -> Result<TeamNodeTerminalResult, StoreFault> {
        let source_envelope_id = format!("team-node-event:{idempotency_key}");
        let (receipt, delivery_id, _node_id, attempt_number, fence, summary, output_port) =
            if let Some(terminal) = terminal {
                let receipt = organization::AuthorizedGraphResolutionReceipt::try_new(
                    terminal.receipt.clone(),
                )
                .map_err(|_| StoreFault::InvalidFacts)?;
                let delivery_id = DeliveryId::new(terminal.delivery_id.clone())
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let node_id = NodeId::new(terminal.node_id.clone());
                let run = store.facts().run(run_id).ok_or(StoreFault::InvalidFacts)?;
                let attempt = run
                    .graph()
                    .current_attempt(&node_id)
                    .filter(|attempt| attempt.number() == terminal.attempt_number)
                    .ok_or(StoreFault::InvalidFacts)?;
                (
                    receipt,
                    delivery_id,
                    node_id,
                    terminal.attempt_number,
                    attempt.fence().clone(),
                    terminal.summary.as_str(),
                    Some(terminal.output_port.as_str()),
                )
            } else {
                let mut matches = store
                    .facts()
                    .deliveries()
                    .deliveries()
                    .filter_map(|delivery| match delivery.phase() {
                        DeliveryPhase::TerminalObserved { observation }
                            if delivery.facts().run_id == run_id.as_str()
                                && delivery.facts().node_execution_id
                                    == node_execution_id.as_str() =>
                        {
                            Some((delivery, observation))
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                if matches.len() != 1 {
                    return Err(StoreFault::InvalidFacts);
                }
                let (delivery, observation) = matches.pop().expect("single terminal observation");
                let node_id = NodeId::new(observation.node_id().to_owned());
                let run = store.facts().run(run_id).ok_or(StoreFault::InvalidFacts)?;
                let attempt = run
                    .graph()
                    .current_attempt(&node_id)
                    .filter(|attempt| attempt.fence() == observation.fence())
                    .ok_or(StoreFault::InvalidFacts)?;
                (
                    organization::AuthorizedGraphResolutionReceipt::try_new(
                        source_envelope_id.clone(),
                    )
                    .map_err(|_| StoreFault::InvalidFacts)?,
                    DeliveryId::new(delivery.facts().delivery_id.as_str().to_owned())
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    node_id,
                    attempt.number(),
                    observation.fence().clone(),
                    summary,
                    output_port,
                )
            };
        if fence.node_execution_id().as_str() != node_execution_id.as_str() {
            return Err(StoreFault::InvalidFacts);
        }
        let resolution = match event {
            "complete" => organization::TeamNodeEventProducer::complete(
                Some(delivery_id),
                Some(receipt),
                Some(run_id.clone()),
                Some(fence),
                Some(attempt_number),
                summary.to_owned(),
                source_envelope_id,
                idempotency_key.to_owned(),
                output_port.map(str::to_owned),
                resolved_at,
            ),
            "reject" => organization::TeamNodeEventProducer::reject(
                Some(delivery_id),
                Some(receipt),
                Some(run_id.clone()),
                Some(fence),
                Some(attempt_number),
                summary.to_owned(),
                source_envelope_id,
                idempotency_key.to_owned(),
                output_port.map(str::to_owned),
                resolved_at,
            ),
            _ => return Err(StoreFault::InvalidFacts),
        }
        .map_err(|_| StoreFault::InvalidFacts)?
        .into_resolution();
        let outcome = store.apply_agent_node_event_resolution(resolution)?;
        Ok(match outcome {
            organization::AuthorizedGraphResolutionOutcome::Recorded => {
                TeamNodeTerminalResult::Recorded
            }
            organization::AuthorizedGraphResolutionOutcome::Replayed => {
                TeamNodeTerminalResult::Replayed
            }
        })
    }

    pub(crate) fn resolve_authorized_graph_outcome(
        &self,
        store: &mut OrganizationStore,
        resolution: organization::AuthorizedGraphResolution,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        let run_id = organization::GraphRunId::new(resolution.graph_run_id().to_owned());
        store.apply_authorized_graph_resolution(resolution)?;
        let team = store
            .facts()
            .run(&run_id)
            .expect("graph resolution preserves its extant TeamRun")
            .team()
            .clone();
        Ok(self.recover(store, TeamRunQuery::get(team, run_id)))
    }

    /// Consumes a trusted native Review result only after terminal observation has been durable.
    /// The native status wire cannot call this with a guessed summary or synthetic receipt.
    pub(crate) fn resolve_review_after_terminal_observation(
        &self,
        store: &mut OrganizationStore,
        preparation: &super::review::ReviewDispatchPreparation,
        input: super::review::ReviewResolutionInput,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        let (_, resolution) =
            super::review::resolve_review_after_terminal_observation(preparation, input)
                .map_err(StoreFault::AgentNodeEventResolution)?;
        let run_id = resolution.graph_run_id().clone();
        store.apply_agent_node_event_resolution(resolution)?;
        let team = store
            .facts()
            .run(&run_id)
            .expect("review resolution preserves its extant TeamRun")
            .team()
            .clone();
        Ok(self.recover(store, TeamRunQuery::get(team, run_id)))
    }

    pub(crate) fn observe_matcha_terminal(
        &self,
        store: &mut OrganizationStore,
        target: MatchaTerminalReceiptTarget,
        native_terminal: NativeTerminalStatus,
        observed_at: u64,
    ) -> Result<TeamRunTerminalObservationOutcome, StoreFault> {
        let run_id = target.graph_run_id().clone();
        let observation = store.observe_matcha_terminal(target, native_terminal, observed_at)?;
        let team = store
            .facts()
            .run(&run_id)
            .expect("terminal observation preserves its extant TeamRun")
            .team()
            .clone();
        Ok(TeamRunTerminalObservationOutcome {
            observation,
            run: self.recover(store, TeamRunQuery::get(team, run_id)),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TeamRunTriggerOutcome {
    pub(crate) registration: TriggerRegistration,
    pub(crate) run: TeamRunCommandOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TeamRunTerminalObservationOutcome {
    pub(crate) observation: TerminalObservationOutcome,
    pub(crate) run: TeamRunCommandOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamRunCommandOutcome {
    Available(TeamRunProjection),
    Unavailable,
    OutcomeUnknown,
}

impl TeamRunCommandOutcome {
    fn from_query(outcome: TeamRunQueryOutcome) -> Self {
        match outcome {
            TeamRunQueryOutcome::Available(projection) => Self::Available(projection),
            TeamRunQueryOutcome::Unavailable => Self::Unavailable,
            TeamRunQueryOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

fn agent_task_execution_request(
    store: &OrganizationStore,
    activity: &ActivityRequest,
) -> Result<ActivityExecutionRequest, TeamRunActivityError> {
    let run = store
        .facts()
        .run(&activity.run_id)
        .ok_or(TeamRunActivityError::SessionMismatch)?;
    let ActivityKind::AgentTask { role_id, .. } = &activity.activity_kind else {
        return Err(TeamRunActivityError::InvalidPrompt);
    };
    let role =
        RoleId::try_new(role_id.clone()).map_err(|_| TeamRunActivityError::SessionMismatch)?;
    let binding = run
        .runtime()
        .and_then(|runtime| {
            runtime
                .bindings()
                .iter()
                .find(|binding| binding.role() == &role)
        })
        .cloned()
        .ok_or(TeamRunActivityError::SessionMismatch)?;
    if binding.local_session().as_str() != activity.target.as_str() {
        return Err(TeamRunActivityError::SessionMismatch);
    }
    if binding.agent().as_str().trim().is_empty()
        || binding.external_session().as_str().trim().is_empty()
    {
        return Err(TeamRunActivityError::InvalidBinding);
    }
    Ok(ActivityExecutionRequest::agent_task(
        AgentTaskActivity::from_activity_request(run.team(), activity, binding)
            .map_err(team_run_activity_error)?,
    ))
}

fn matcha_activity_correlation(
    store: &OrganizationStore,
    activity_id: &ActivityId,
) -> Option<MatchaDeliveryCorrelation> {
    let activity = store.facts().activities().activity(activity_id)?;
    let run = store.facts().run(&activity.facts().run_id)?;
    let ActivityKind::AgentTask { role_id, .. } = &activity.facts().activity_kind else {
        return None;
    };
    let role = RoleId::try_new(role_id.clone()).ok()?;
    let binding = run
        .runtime()?
        .bindings()
        .iter()
        .find(|binding| binding.role() == &role)?;
    (binding.endpoint().as_str()
        == crate::runtime_driver::RuntimeDriverIdentity::matcha_agent()
            .runtime_endpoint_reference())
    .then(|| {
        MatchaDeliveryCorrelation::new(
            binding.external_session().clone(),
            NativeRunReceiptReference::try_new(activity.facts().idempotency_key.clone())
                .expect("validated Matcha activity idempotency key must be a native run receipt"),
        )
    })
}

fn team_run_activity_error(error: ActivityExecutionRequestError) -> TeamRunActivityError {
    match error {
        ActivityExecutionRequestError::InvalidDeliveryReference => {
            TeamRunActivityError::SessionMismatch
        }
        ActivityExecutionRequestError::InvalidIdempotencyKey => {
            TeamRunActivityError::InvalidBinding
        }
        ActivityExecutionRequestError::InvalidPromptPayload => TeamRunActivityError::InvalidPrompt,
    }
}

fn persisted_graph_template(
    facts: &organization::OrganizationFacts,
    team_id: &TeamId,
) -> Option<GraphDefinition> {
    facts
        .runs()
        .filter(|run| run.team() == team_id)
        .map(|run| run.graph().definition().clone())
        .next()
}

fn default_graph_template(team_id: &TeamId, team_name: &str) -> GraphDefinition {
    GraphDefinition::new(
        format!("team-graph-template:{}", team_id.as_str()),
        format!("team-graph-template-plan:{}", team_id.as_str()),
        GraphRunId::new(format!("team-graph-template-run:{}", team_id.as_str())),
        team_name,
        vec![NodeDefinition::start(
            NodeId::new("start"),
            "Start",
            std::num::NonZeroU32::MIN,
            None,
        )],
        Vec::new(),
    )
    .expect("default Team graph template must be valid")
}

fn instantiate_graph_template(
    template: &GraphDefinition,
    run_id: GraphRunId,
    idempotency_key: &str,
) -> Result<GraphDefinition, StoreFault> {
    if idempotency_key.trim().is_empty() {
        return Err(StoreFault::InvalidFacts);
    }
    GraphDefinition::new(
        format!("team-graph:{}", run_id.as_str()),
        format!("graph-{idempotency_key}"),
        run_id,
        template.title().to_owned(),
        template.nodes().to_vec(),
        template.edges().to_vec(),
    )
    .map_err(|_| StoreFault::InvalidFacts)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        num::NonZeroU32,
        sync::atomic::{AtomicU64, Ordering},
    };

    use organization::{
        DeliveryLedgerSnapshot, GraphDefinition, GraphRunId, GraphState, MaterializationReceipt,
        MemberId, NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind,
        RoleMaterializationReceipt, RuntimeEndpointReference, TeamDefinition, TeamFacts, TeamId,
        TeamMember, TeamRevision, TeamRole,
    };

    use super::*;

    static NEXT_PATH_ID: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn create_requires_confirmed_materialization_and_leaves_no_run() {
        let path = test_path("requires-materialization");
        let mut store = OrganizationStore::open(&path).unwrap();
        store.replace_facts(facts(None)).unwrap();
        let owner = TeamRunOwner::new();

        assert_eq!(
            owner.create(&mut store, run(), "create:one"),
            Err(StoreFault::InvalidFacts)
        );
        assert!(store.facts().run(&GraphRunId::new("run:one")).is_none());

        drop(store);
        remove_test_path(&path);
    }

    #[test]
    fn create_replays_only_after_confirmed_materialization_without_runtime_receipt() {
        let path = test_path("create-and-recover");
        let mut store = OrganizationStore::open(&path).unwrap();
        store.replace_facts(facts(Some(materialization()))).unwrap();
        let owner = TeamRunOwner::new();

        assert_eq!(
            owner.create(&mut store, run(), "create:one"),
            Ok(CreateGraphRunOutcome::Created(GraphRunId::new("run:one")))
        );
        assert_eq!(
            owner.recover(
                &store,
                TeamRunQuery::get(team(), GraphRunId::new("run:one"))
            ),
            TeamRunCommandOutcome::OutcomeUnknown
        );
        assert_eq!(
            owner.create(&mut store, run(), "create:one"),
            Ok(CreateGraphRunOutcome::Replayed(GraphRunId::new("run:one")))
        );
        assert_eq!(
            owner.create(&mut store, run(), "create:other"),
            Ok(CreateGraphRunOutcome::ExistingRun)
        );
        assert_eq!(store.facts().runs().count(), 1);
        assert!(
            store
                .facts()
                .run(&GraphRunId::new("run:one"))
                .unwrap()
                .runtime()
                .is_none()
        );

        drop(store);
        remove_test_path(&path);
    }

    #[test]
    fn persisted_template_is_team_scoped_and_instantiation_preserves_creation_identity() {
        let first_team = team();
        let second_team = TeamId::try_new("team:two").unwrap();
        let first_definition = graph_definition("graph:first", "plan:first", "run:first");
        let second_definition = graph_definition("graph:second", "plan:second", "run:second");
        let facts = OrganizationFacts::restore(
            vec![
                TeamFacts::new(
                    team_definition_for(first_team.clone()),
                    TeamRevision::initial(),
                    false,
                ),
                TeamFacts::new(
                    team_definition_for(second_team.clone()),
                    TeamRevision::initial(),
                    false,
                ),
            ],
            [],
            [
                GraphRunFacts::new(
                    first_team.clone(),
                    TeamRevision::initial(),
                    GraphState::initialize(first_definition.clone(), 11),
                    None,
                )
                .unwrap(),
                GraphRunFacts::new(
                    second_team.clone(),
                    TeamRevision::initial(),
                    GraphState::initialize(second_definition, 12),
                    None,
                )
                .unwrap(),
            ],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();

        assert_eq!(
            persisted_graph_template(&facts, &first_team),
            Some(first_definition.clone())
        );
        assert_eq!(
            persisted_graph_template(&facts, &TeamId::try_new("team:missing").unwrap()),
            None
        );

        let instantiated =
            instantiate_graph_template(&first_definition, GraphRunId::new("run:new"), "create:new")
                .unwrap();
        assert_eq!(instantiated.graph_id(), "team-graph:run:new");
        assert_eq!(instantiated.workflow_plan_id(), "graph-create:new");
        assert_eq!(instantiated.run_id().as_str(), "run:new");
        assert_eq!(instantiated.title(), first_definition.title());
        assert_eq!(instantiated.nodes(), first_definition.nodes());
        assert_eq!(instantiated.edges(), first_definition.edges());
        let state = organization::GraphState::initialize(instantiated, 73);
        assert_eq!(
            state
                .current_attempt(&NodeId::new("start"))
                .expect("instantiated graph retains its node execution")
                .created_at(),
            73
        );
    }

    #[test]
    fn owner_never_opens_or_materializes_an_organization_store() {
        let source = include_str!("team_run.rs")
            .split_once("\n#[cfg(test)]")
            .expect("team run source must retain its test boundary")
            .0;

        assert!(!source.contains("OrganizationStore::open"));
        assert!(!source.contains("TeamMaterialization"));
        assert!(!source.contains("WorkspaceBinding"));
        assert!(!source.contains(concat!("NativeWorkspace", "Grant")));
        assert!(!source.contains(concat!("RoleSession", "Request")));
        assert!(!source.contains(concat!("create_role_", "session")));
        assert!(!source.contains(concat!("start_role_", "session")));
    }

    fn facts(materialization: Option<MaterializationReceipt>) -> OrganizationFacts {
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            materialization,
            [],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap()
    }

    fn graph_definition(graph_id: &str, workflow_plan_id: &str, run_id: &str) -> GraphDefinition {
        GraphDefinition::new(
            graph_id,
            workflow_plan_id,
            GraphRunId::new(run_id),
            "team graph",
            vec![NodeDefinition::start(
                NodeId::new("start"),
                "start",
                NonZeroU32::new(1).unwrap(),
                None,
            )],
            Vec::new(),
        )
        .unwrap()
    }

    fn run() -> GraphRunFacts {
        GraphRunFacts::new(
            team(),
            TeamRevision::initial(),
            GraphState::initialize(
                GraphDefinition::new(
                    "graph:one",
                    "plan:one",
                    GraphRunId::new("run:one"),
                    "team graph",
                    vec![NodeDefinition::start(
                        NodeId::new("start"),
                        "start",
                        NonZeroU32::new(1).unwrap(),
                        None,
                    )],
                    Vec::new(),
                )
                .unwrap(),
                1,
            ),
            None,
        )
        .unwrap()
    }

    fn materialization() -> MaterializationReceipt {
        let endpoint = RuntimeEndpointReference::try_new("private-runtime-endpoint").unwrap();
        MaterializationReceipt::try_new(
            team(),
            endpoint.clone(),
            vec![RoleMaterializationReceipt::new(
                RoleId::try_new("leader").unwrap(),
                organization::ManagedAgentReference::try_new("private-agent-token").unwrap(),
                endpoint,
            )],
        )
        .unwrap()
    }

    fn team() -> TeamId {
        TeamId::try_new("team:one").unwrap()
    }

    fn team_definition() -> TeamDefinition {
        team_definition_for(team())
    }

    fn team_definition_for(team_id: TeamId) -> TeamDefinition {
        let member =
            TeamMember::try_new(MemberId::try_new("member:leader").unwrap(), "Leader").unwrap();
        let role = TeamRole::try_new(
            RoleId::try_new("leader").unwrap(),
            "Leader",
            RoleKind::Leader,
        )
        .unwrap();
        TeamDefinition::try_new(
            team_id,
            "Test team",
            vec![member.clone()],
            vec![role.clone()],
            vec![RoleAssignment::new(
                member.member_id().clone(),
                role.role_id().clone(),
            )],
        )
        .unwrap()
    }

    fn test_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "runtime-host-team-run-{label}-{}-{}.log",
            std::process::id(),
            NEXT_PATH_ID.fetch_add(1, Ordering::Relaxed),
        ))
    }

    fn remove_test_path(path: &std::path::Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(format!("{}.lock", path.display()));
    }
}
