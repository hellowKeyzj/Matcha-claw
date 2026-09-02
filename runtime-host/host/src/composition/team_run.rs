use matcha_agent::peer::TerminalReceiptReadError;
use organization::{
    BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryClaim, DeliveryId, DeliveryPhase,
    DeliveryReceipt, DeliveryReference, DeliveryRejection, DeliveryStart, GraphDefinition,
    GraphRunFacts, GraphRunId, GraphRunPurgeOutcome, GraphState, IdempotencyKey,
    MatchaDeliveryCorrelation, MatchaTerminalReceiptTarget, NativeRunReceiptReference,
    NativeTerminalStatus, NodeDefinition, NodeId, OrganizationStore, PromptDeliveryOutcome,
    PromptDeliveryRequest, PromptDispatchPayload, ResumeOutcome, RoleAbortOutcome, RoleId,
    RoleSessionReceipt, RuntimeEndpointReference, SettleCancellationOutcome, StoreFault,
    TeamDecisionCommand, TeamDecisionReceipt, TeamGraphContextQuery, TeamGraphContextResult,
    TeamId, TeamNodeEvent, TeamNodeEventOutcome, TeamRunProjection, TeamRunQuery,
    TeamRunQueryOutcome, TerminalObservationOutcome, TombstoneOutcome, TriggerFireRequest,
    TriggerRegistration, plan_terminal_observations, query_team_run,
    run::lifecycle::GraphRunLifecycleState,
    run::scheduler::{NodePromptRetryDueQuery, NodePromptRetryDueQueryOutcome},
};

use super::session::RuntimeSessionError;

/// The only Host-composed TeamRun semantic seam. It reads the existing Organization durable owner
/// and deliberately has no materialization or recovery provider attached.
pub(crate) struct TeamRunOwner;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamRunDeliveryTarget {
    OpenClaw { run_id: GraphRunId },
    Matcha { run_id: GraphRunId },
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MatchaDeliveryError {
    InvalidPrompt,
    InvalidSession,
    SessionMismatch,
    Store(StoreFault),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OpenClawDeliveryError {
    InvalidPrompt,
    InvalidBinding,
    SessionMismatch,
    Unavailable,
    Store(StoreFault),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OpenClawDeliveryOutcome {
    Delivered(TeamRunCommandOutcome),
    AlreadyClaimed(TeamRunCommandOutcome),
    AwaitingRetry(TeamRunCommandOutcome),
    Terminal(TeamRunCommandOutcome),
    OutcomeUnknown(TeamRunCommandOutcome),
}

pub(crate) enum OpenClawDeliveryStart {
    Claimed {
        claim: DeliveryClaim,
        delivery: PromptDeliveryRequest,
    },
    Immediate(OpenClawDeliveryOutcome),
}

pub(crate) enum MatchaDeliveryStartOutcome {
    Claimed {
        claim: DeliveryClaim,
        delivery: PromptDeliveryRequest,
    },
    AlreadyClaimed(TeamRunCommandOutcome),
    AwaitingRetry(TeamRunCommandOutcome),
    Terminal(TeamRunCommandOutcome),
    OutcomeUnknown(TeamRunCommandOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MatchaDeliveryOutcome {
    Delivered(TeamRunCommandOutcome),
    AlreadyClaimed(TeamRunCommandOutcome),
    AwaitingRetry(TeamRunCommandOutcome),
    Terminal(TeamRunCommandOutcome),
    OutcomeUnknown(TeamRunCommandOutcome),
}

impl TeamRunOwner {
    pub(crate) const fn new() -> Self {
        Self
    }

    fn recover_delivery_run(
        &self,
        store: &OrganizationStore,
        delivery_id: &DeliveryId,
    ) -> TeamRunCommandOutcome {
        let run_id = organization::GraphRunId::new(
            store
                .facts()
                .deliveries()
                .delivery(delivery_id)
                .expect("delivery command preserves its extant delivery")
                .facts()
                .run_id
                .clone(),
        );
        let team = store
            .facts()
            .run(&run_id)
            .expect("delivery command preserves its extant TeamRun")
            .team()
            .clone();
        self.recover(store, TeamRunQuery::get(team, run_id))
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

    pub(crate) fn claim_delivery(
        &self,
        store: &mut OrganizationStore,
        delivery_id: &DeliveryId,
        claimed_at: u64,
    ) -> Result<organization::DeliveryStart, StoreFault> {
        store.claim_delivery(delivery_id, claimed_at)
    }

    pub(crate) fn settle_delivery(
        &self,
        store: &mut OrganizationStore,
        claim: &organization::DeliveryClaim,
        receipt: organization::DeliveryReceipt,
        retry_at: u64,
    ) -> Result<organization::DeliveryResolution, StoreFault> {
        store.settle_delivery(claim, receipt, retry_at)
    }

    pub(crate) fn claim_matcha_delivery(
        &self,
        store: &mut OrganizationStore,
        delivery_id: DeliveryId,
        claimed_at: u64,
    ) -> Result<MatchaDeliveryStartOutcome, MatchaDeliveryError> {
        let (binding, prompt) = matcha_role_delivery(store, &delivery_id)?;
        let delivery = PromptDeliveryRequest::new(
            DeliveryReference::try_new(delivery_id.as_str().to_owned())
                .map_err(|_| MatchaDeliveryError::SessionMismatch)?,
            binding,
            IdempotencyKey::try_new(delivery_id.as_str().to_owned())
                .map_err(|_| MatchaDeliveryError::InvalidSession)?,
            PromptDispatchPayload::try_new(prompt)
                .map_err(|_| MatchaDeliveryError::InvalidPrompt)?,
        );
        match self
            .claim_delivery(store, &delivery_id, claimed_at)
            .map_err(MatchaDeliveryError::Store)?
        {
            DeliveryStart::Claimed(claim) => {
                Ok(MatchaDeliveryStartOutcome::Claimed { claim, delivery })
            }
            DeliveryStart::AlreadyClaimed(_) => Ok(MatchaDeliveryStartOutcome::AlreadyClaimed(
                self.recover_delivery_run(store, &delivery_id),
            )),
            DeliveryStart::AwaitingRetry { .. } => Ok(MatchaDeliveryStartOutcome::AwaitingRetry(
                self.recover_delivery_run(store, &delivery_id),
            )),
            DeliveryStart::Terminal(phase) => Ok(match phase {
                DeliveryPhase::OutcomeUnknown { .. } => MatchaDeliveryStartOutcome::OutcomeUnknown(
                    self.recover_delivery_run(store, &delivery_id),
                ),
                _ => MatchaDeliveryStartOutcome::Terminal(
                    self.recover_delivery_run(store, &delivery_id),
                ),
            }),
        }
    }

    pub(crate) fn claim_openclaw_delivery(
        &self,
        store: &mut OrganizationStore,
        delivery_id: DeliveryId,
        claimed_at: u64,
    ) -> Result<OpenClawDeliveryStart, OpenClawDeliveryError> {
        let (binding, prompt) = openclaw_role_delivery(store, &delivery_id)?;
        let delivery = PromptDeliveryRequest::new(
            DeliveryReference::try_new(delivery_id.as_str().to_owned())
                .map_err(|_| OpenClawDeliveryError::SessionMismatch)?,
            binding,
            IdempotencyKey::try_new(delivery_id.as_str().to_owned())
                .map_err(|_| OpenClawDeliveryError::InvalidBinding)?,
            PromptDispatchPayload::try_new(prompt)
                .map_err(|_| OpenClawDeliveryError::InvalidPrompt)?,
        );
        match self
            .claim_delivery(store, &delivery_id, claimed_at)
            .map_err(OpenClawDeliveryError::Store)?
        {
            DeliveryStart::Claimed(claim) => Ok(OpenClawDeliveryStart::Claimed { claim, delivery }),
            DeliveryStart::AlreadyClaimed(_) => Ok(OpenClawDeliveryStart::Immediate(
                OpenClawDeliveryOutcome::AlreadyClaimed(
                    self.recover_delivery_run(store, &delivery_id),
                ),
            )),
            DeliveryStart::AwaitingRetry { .. } => Ok(OpenClawDeliveryStart::Immediate(
                OpenClawDeliveryOutcome::AwaitingRetry(
                    self.recover_delivery_run(store, &delivery_id),
                ),
            )),
            DeliveryStart::Terminal(phase) => Ok(OpenClawDeliveryStart::Immediate(match phase {
                DeliveryPhase::OutcomeUnknown { .. } => OpenClawDeliveryOutcome::OutcomeUnknown(
                    self.recover_delivery_run(store, &delivery_id),
                ),
                _ => OpenClawDeliveryOutcome::Terminal(
                    self.recover_delivery_run(store, &delivery_id),
                ),
            })),
        }
    }

    pub(crate) fn settle_openclaw_delivery(
        &self,
        store: &mut OrganizationStore,
        claim: DeliveryClaim,
        outcome: PromptDeliveryOutcome,
        retry_at: u64,
    ) -> Result<OpenClawDeliveryOutcome, OpenClawDeliveryError> {
        let delivery_id = claim.delivery_id().clone();
        let claimed_at = claim.claimed_at();
        let receipt = match outcome {
            PromptDeliveryOutcome::Delivered { receipt } => DeliveryReceipt::Accepted {
                receipt,
                matcha_correlation: None,
                accepted_at: claimed_at,
            },
            PromptDeliveryOutcome::Rejected { rejection } => DeliveryReceipt::Rejected {
                failure: match rejection {
                    DeliveryRejection::Permanent => organization::DeliveryFailure::PolicyRejected,
                    DeliveryRejection::Retryable => organization::DeliveryFailure::Unavailable,
                },
                observed_at: claimed_at,
            },
            PromptDeliveryOutcome::OutcomeUnknown => DeliveryReceipt::OutcomeUnknown {
                observed_at: claimed_at,
            },
        };
        let resolution = self
            .settle_delivery(store, &claim, receipt, retry_at)
            .map_err(OpenClawDeliveryError::Store)?;
        Ok(match resolution {
            organization::DeliveryResolution::Delivered => {
                OpenClawDeliveryOutcome::Delivered(self.recover_delivery_run(store, &delivery_id))
            }
            organization::DeliveryResolution::RetryScheduled { .. } => {
                OpenClawDeliveryOutcome::AwaitingRetry(
                    self.recover_delivery_run(store, &delivery_id),
                )
            }
            organization::DeliveryResolution::Failed => {
                OpenClawDeliveryOutcome::Terminal(self.recover_delivery_run(store, &delivery_id))
            }
            organization::DeliveryResolution::OutcomeUnknown => {
                OpenClawDeliveryOutcome::OutcomeUnknown(
                    self.recover_delivery_run(store, &delivery_id),
                )
            }
        })
    }

    pub(crate) fn settle_matcha_delivery(
        &self,
        store: &mut OrganizationStore,
        claim: DeliveryClaim,
        delivery: PromptDeliveryRequest,
        outcome: PromptDeliveryOutcome,
        retry_at: u64,
    ) -> Result<MatchaDeliveryOutcome, MatchaDeliveryError> {
        let delivery_id = claim.delivery_id().clone();
        let observed_at = claim.claimed_at();
        let receipt = match outcome {
            PromptDeliveryOutcome::Delivered { receipt } => DeliveryReceipt::Accepted {
                receipt,
                matcha_correlation: Some(MatchaDeliveryCorrelation::new(
                    delivery.binding().external_session().clone(),
                    NativeRunReceiptReference::try_new(
                        delivery.idempotency_key().as_str().to_owned(),
                    )
                    .expect("validated Matcha delivery id must be a valid native run receipt"),
                )),
                accepted_at: observed_at,
            },
            PromptDeliveryOutcome::Rejected { rejection } => DeliveryReceipt::Rejected {
                failure: match rejection {
                    DeliveryRejection::Permanent => organization::DeliveryFailure::PolicyRejected,
                    DeliveryRejection::Retryable => organization::DeliveryFailure::Unavailable,
                },
                observed_at,
            },
            PromptDeliveryOutcome::OutcomeUnknown => {
                DeliveryReceipt::OutcomeUnknown { observed_at }
            }
        };
        let resolution = self
            .settle_delivery(store, &claim, receipt, retry_at)
            .map_err(MatchaDeliveryError::Store)?;
        Ok(match resolution {
            organization::DeliveryResolution::Delivered => {
                MatchaDeliveryOutcome::Delivered(self.recover_delivery_run(store, &delivery_id))
            }
            organization::DeliveryResolution::RetryScheduled { .. } => {
                MatchaDeliveryOutcome::AwaitingRetry(self.recover_delivery_run(store, &delivery_id))
            }
            organization::DeliveryResolution::Failed => {
                MatchaDeliveryOutcome::Terminal(self.recover_delivery_run(store, &delivery_id))
            }
            organization::DeliveryResolution::OutcomeUnknown => {
                MatchaDeliveryOutcome::OutcomeUnknown(
                    self.recover_delivery_run(store, &delivery_id),
                )
            }
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

    pub(crate) fn pending_delivery_ids(
        &self,
        store: &OrganizationStore,
        now: u64,
    ) -> Vec<DeliveryId> {
        store
            .facts()
            .deliveries()
            .deliveries()
            .filter_map(|delivery| match delivery.phase() {
                DeliveryPhase::Pending => Some(delivery.facts().delivery_id.clone()),
                DeliveryPhase::RetryScheduled { retry_at, .. } if *retry_at <= now => {
                    Some(delivery.facts().delivery_id.clone())
                }
                _ => None,
            })
            .collect()
    }

    pub(crate) fn delivery_target(
        &self,
        store: &OrganizationStore,
        delivery_id: &DeliveryId,
        open_claw_endpoint: &RuntimeEndpointReference,
        matcha_endpoint: &RuntimeEndpointReference,
    ) -> Option<TeamRunDeliveryTarget> {
        let delivery = store.facts().deliveries().delivery(delivery_id)?;
        let run_id = GraphRunId::new(delivery.facts().run_id.clone());
        let run = store.facts().run(&run_id)?;
        let role = RoleId::try_new(delivery.facts().role_id.clone()).ok()?;
        let binding = run
            .runtime()?
            .bindings()
            .iter()
            .find(|binding| binding.role() == &role)?;
        if binding.endpoint() == open_claw_endpoint {
            Some(TeamRunDeliveryTarget::OpenClaw { run_id })
        } else if binding.endpoint() == matcha_endpoint {
            Some(TeamRunDeliveryTarget::Matcha { run_id })
        } else {
            None
        }
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

fn openclaw_role_delivery(
    store: &OrganizationStore,
    delivery_id: &DeliveryId,
) -> Result<(RoleSessionReceipt, String), OpenClawDeliveryError> {
    role_delivery_binding(store, delivery_id)
        .ok_or(OpenClawDeliveryError::SessionMismatch)
        .and_then(|(binding, prompt)| {
            if binding.agent().as_str().trim().is_empty()
                || binding.external_session().as_str().trim().is_empty()
            {
                return Err(OpenClawDeliveryError::InvalidBinding);
            }
            Ok((binding, prompt))
        })
}

fn matcha_role_delivery(
    store: &OrganizationStore,
    delivery_id: &DeliveryId,
) -> Result<(RoleSessionReceipt, String), MatchaDeliveryError> {
    role_delivery_binding(store, delivery_id).ok_or(MatchaDeliveryError::SessionMismatch)
}

fn role_delivery_binding(
    store: &OrganizationStore,
    delivery_id: &DeliveryId,
) -> Option<(RoleSessionReceipt, String)> {
    let delivery = store.facts().deliveries().delivery(delivery_id)?;
    let run = store.facts().run(&organization::GraphRunId::new(
        delivery.facts().run_id.clone(),
    ))?;
    let role = RoleId::try_new(delivery.facts().role_id.clone()).ok()?;
    let binding = run
        .runtime()?
        .bindings()
        .iter()
        .find(|binding| binding.role() == &role)?;
    Some((binding.clone(), delivery.facts().message.clone()))
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
