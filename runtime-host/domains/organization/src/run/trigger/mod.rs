mod capability;
mod fire;
mod ledger;
mod webhook;

use crate::{GraphRunId, NodeId, StartTrigger, TeamId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArmedTriggerFacts {
    pub team_id: TeamId,
    pub run_id: GraphRunId,
    pub start_node_id: NodeId,
    pub trigger: StartTrigger,
}

pub use capability::{TeamTriggerFireOutcome, TeamTriggerFireRequest, TeamTriggerFireRequestError};
pub use fire::{TriggerFireError, TriggerFireRequest, TriggerFireRequestError, TriggerSource};
pub use ledger::{RestoreTriggerLedgerError, TriggerLedger, TriggerRegistration};
pub use webhook::{
    ArmedWebhookTrigger, WebhookTriggerResolution, WebhookTriggerResolutionError,
    resolve_webhook_trigger,
};
