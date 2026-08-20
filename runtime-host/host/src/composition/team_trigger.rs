use organization::{
    GraphRunId, StartTrigger, StoreFault, TeamId, TeamTriggerFireOutcome, TeamTriggerFireRequest,
    TeamTriggerFireRequestError, TriggerFireRequest, TriggerSource,
    run::lifecycle::GraphRunLifecycleState,
};

use super::team_run::TeamRunOwner;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ArmedTrigger {
    pub(crate) team_id: TeamId,
    pub(crate) run_id: GraphRunId,
    pub(crate) start_node_id: String,
    pub(crate) trigger: Trigger,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Trigger {
    Webhook { path: String },
    Cron { expression: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamTriggerFireResolution {
    Request(TeamTriggerFireRequest),
    NotFound,
    Rejected,
}

impl TeamRunOwner {
    pub(crate) fn produce_team_trigger_fire_request(
        &self,
        armed: &ArmedTrigger,
        idempotency_key: impl Into<String>,
    ) -> Result<TeamTriggerFireRequest, TeamTriggerFireRequestError> {
        let source = match armed.trigger {
            Trigger::Webhook { .. } => TriggerSource::Webhook,
            Trigger::Cron { .. } => TriggerSource::Cron,
        };
        let trigger = TriggerFireRequest::try_new(
            armed.run_id.as_str(),
            armed.start_node_id.as_str(),
            source,
            idempotency_key,
        )
        .map_err(TeamTriggerFireRequestError::InvalidTrigger)?;
        TeamTriggerFireRequest::try_new(armed.team_id.clone(), trigger)
    }

    pub(crate) fn resolve_webhook_fire(
        &self,
        armed_triggers: impl IntoIterator<Item = ArmedTrigger>,
        webhook_path: &str,
        idempotency_key: String,
    ) -> TeamTriggerFireResolution {
        let armed_triggers: Vec<_> = armed_triggers.into_iter().collect();
        let resolution = organization::resolve_webhook_trigger(
            armed_triggers
                .iter()
                .filter_map(|trigger| match &trigger.trigger {
                    Trigger::Webhook { path } => Some(organization::ArmedWebhookTrigger {
                        run_id: trigger.run_id.as_str().to_owned(),
                        start_node_id: trigger.start_node_id.clone(),
                        path: path.clone(),
                    }),
                    Trigger::Cron { .. } => None,
                }),
            webhook_path,
            idempotency_key,
        );
        let Ok(organization::WebhookTriggerResolution::Fire(request)) = resolution else {
            return match resolution {
                Ok(organization::WebhookTriggerResolution::NotFound) => {
                    TeamTriggerFireResolution::NotFound
                }
                _ => TeamTriggerFireResolution::Rejected,
            };
        };
        let Some(armed) = armed_triggers.iter().find(|trigger| {
            trigger.run_id.as_str() == request.run_id
                && trigger.start_node_id == request.start_node_id
                && matches!(trigger.trigger, Trigger::Webhook { .. })
        }) else {
            return TeamTriggerFireResolution::Rejected;
        };
        TeamTriggerFireRequest::try_new(armed.team_id.clone(), request)
            .map(TeamTriggerFireResolution::Request)
            .unwrap_or(TeamTriggerFireResolution::Rejected)
    }

    pub(crate) fn fire_team_trigger(
        &self,
        store: &mut organization::OrganizationStore,
        request: TeamTriggerFireRequest,
        fired_at: u64,
    ) -> Result<TeamTriggerFireOutcome, StoreFault> {
        if request.validate().is_err() {
            return Ok(TeamTriggerFireOutcome::Rejected);
        }
        let run_id = GraphRunId::new(request.trigger.run_id.clone());
        let Some(run) = store.facts().run(&run_id) else {
            return Ok(TeamTriggerFireOutcome::NotFound);
        };
        if run.team() != &request.team_id
            || !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
        {
            return Ok(TeamTriggerFireOutcome::NotFound);
        }
        match self.fire_trigger(store, request.trigger.clone(), fired_at) {
            Ok(outcome) => Ok(TeamTriggerFireOutcome::from_registration(
                request,
                outcome.registration,
            )),
            Err(StoreFault::TriggerFire(organization::TriggerFireError::RunMismatch)) => {
                Ok(TeamTriggerFireOutcome::NotFound)
            }
            Err(StoreFault::TriggerFire(_)) => Ok(TeamTriggerFireOutcome::Rejected),
            Err(StoreFault::CommitOutcomeUnknown(_)) => Ok(TeamTriggerFireOutcome::Unknown),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn armed_triggers(
        &self,
        store: &organization::OrganizationStore,
        team_id: Option<&TeamId>,
    ) -> Vec<ArmedTrigger> {
        store
            .facts()
            .armed_trigger_facts()
            .filter(|facts| team_id.is_none_or(|team_id| &facts.team_id == team_id))
            .map(|facts| {
                let trigger = match facts.trigger {
                    StartTrigger::Webhook { path } => Trigger::Webhook { path },
                    StartTrigger::Cron { expression } => Trigger::Cron { expression },
                };
                ArmedTrigger {
                    team_id: facts.team_id,
                    run_id: facts.run_id,
                    start_node_id: facts.start_node_id.as_str().to_owned(),
                    trigger,
                }
            })
            .collect()
    }
}
