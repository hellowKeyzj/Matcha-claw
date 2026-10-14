use std::sync::Arc;
use tokio::sync::{OnceCell, oneshot};

use platform::call::{CallContext, CallLogError, CallReceipt};

use crate::{
    domain::model::{Command as SubagentCommand, Outcome},
    projection::call::SubagentCallDetail,
};

pub(crate) enum SubagentCommandEnvelope {
    Execute {
        command: SubagentCommand,
        call: Option<CallContext<SubagentCallDetail>>,
        detail: SubagentCallDetail,
        admission: Option<Arc<OnceCell<Result<CallReceipt, CallLogError>>>>,
        reply: oneshot::Sender<Outcome>,
    },
}

pub(crate) enum SubagentQuery {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum SubagentOwnerKey {
    OpenClaw(String),
    MatchaAgent(String),
}

impl SubagentCommandEnvelope {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<SubagentOwnerKey> {
        use crate::domain::model::NativeEndpoint;
        use foundation::execution::CommandRoute;

        let Self::Execute { command, .. } = self;
        let agent_id = match command {
            SubagentCommand::List { .. }
            | SubagentCommand::DisplayConfiguration { .. }
            | SubagentCommand::Create { .. }
            | SubagentCommand::InstallPackage { .. } => return CommandRoute::Exclusive,
            SubagentCommand::Update { input, .. } => &input.agent_id,
            SubagentCommand::Delete { input, .. } => &input.agent_id,
            SubagentCommand::ListFiles { agent_id, .. }
            | SubagentCommand::GetFile { agent_id, .. }
            | SubagentCommand::SetFile { agent_id, .. }
            | SubagentCommand::SetDescription { agent_id, .. }
            | SubagentCommand::SetConfigurationModel { agent_id, .. }
            | SubagentCommand::SetSkills { agent_id, .. }
            | SubagentCommand::SkillConfiguration { agent_id, .. }
            | SubagentCommand::SetSkillConfiguration { agent_id, .. }
            | SubagentCommand::ToolConfiguration { agent_id, .. }
            | SubagentCommand::SetToolConfiguration { agent_id, .. }
            | SubagentCommand::ExportPackage { agent_id, .. }
            | SubagentCommand::ExportCloudPackage { agent_id, .. } => agent_id,
        };
        CommandRoute::Keyed(match command.endpoint() {
            NativeEndpoint::OpenClawLocal => SubagentOwnerKey::OpenClaw(agent_id.clone()),
            NativeEndpoint::MatchaAgentLocal => SubagentOwnerKey::MatchaAgent(agent_id.clone()),
        })
    }
}

impl SubagentQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<SubagentOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
