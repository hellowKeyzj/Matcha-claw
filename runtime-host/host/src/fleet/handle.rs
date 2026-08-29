use std::time::SystemTime;

use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{HostPhase, RequestAdmissionClosed};

use super::command::{FleetCommand, FleetQuery};

/// Fleet owner handle for independent mailbox architecture.
#[derive(Clone)]
pub struct FleetHandle {
    owner: OwnerRuntimeHandle<FleetCommand, FleetQuery>,
}

impl FleetHandle {
    pub fn new(owner: OwnerRuntimeHandle<FleetCommand, FleetQuery>) -> Self {
        Self { owner }
    }

    pub async fn terminal_open_allocated(
        &self,
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        dimensions: fleet::terminal::Dimensions,
    ) -> Result<
        Result<crate::fleet::owner::FleetTerminalOpenResult, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalOpenAllocated {
                selector,
                dimensions,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_consume_ticket(
        &self,
        ticket: Vec<u8>,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalConsumeTicket { ticket, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_provider_open(
        &self,
        context: crate::transport::fleet_terminal::TerminalContext,
    ) -> Result<crate::transport::fleet_terminal::TerminalProviderOpen, ()> {
        let target_id = fleet::TargetId::try_from(context.target.as_str()).map_err(|_| ())?;
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalProviderOpen {
                target_id,
                context,
                reply,
            })
            .await
            .map_err(|_| ())?;
        reply_rx.await.map_err(|_| ())?
    }

    pub async fn terminal_context(
        &self,
        summary: fleet::terminal::SessionSummary,
    ) -> Result<
        Result<
            Option<crate::transport::fleet_terminal::TerminalContext>,
            fleet::FleetDeliveryError,
        >,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::TerminalContext { summary, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_resolve_context(
        &self,
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        summary: fleet::terminal::SessionSummary,
    ) -> Result<
        Result<
            Option<crate::transport::fleet_terminal::TerminalContext>,
            fleet::FleetDeliveryError,
        >,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::TerminalResolveContext {
                selector,
                summary,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_close_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalClose {
                session,
                generation,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_fail_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalFail {
                session,
                generation,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_close(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalCloseCurrent { session, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_begin_close(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalBeginCloseCurrent { session, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_finish_close(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalFinishCloseCurrent { session, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_reconnect(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<
        Result<fleet::terminal::OpenedSession, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalReconnect { session, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_begin_close_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalBeginClose {
                session,
                generation,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_finish_close_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<
        Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::TerminalFinishClose {
                session,
                generation,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn terminal_list(
        &self,
    ) -> Result<Vec<fleet::terminal::SessionSummary>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::TerminalList { reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn query_snapshot(
        &self,
        now: SystemTime,
    ) -> Result<
        Result<fleet::query::FleetQuerySnapshot, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::QuerySnapshot { now, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn snapshot(
        &self,
        now: SystemTime,
    ) -> Result<
        Result<crate::fleet::owner::FleetSnapshot, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::Snapshot { now, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn selector_preview(
        &self,
        constraints: fleet::query::SelectorConstraints,
        now: SystemTime,
    ) -> Result<
        Result<fleet::query::SelectorPreview, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::SelectorPreview {
                constraints,
                now,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn target_summaries(
        &self,
    ) -> Result<
        Result<Vec<crate::fleet::owner::FleetTargetSummary>, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::TargetSummaries { reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn target_selector(
        &self,
        id: fleet::TargetId,
        revision: u64,
        kind: fleet::TargetKind,
    ) -> Result<
        Result<Option<fleet::FleetTargetSelector>, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::TargetSelector {
                id,
                revision,
                kind,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn topology_summary(
        &self,
    ) -> Result<
        Result<crate::fleet::owner::FleetTopologySummary, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::TopologySummary { reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn put_target(
        &self,
        id: fleet::TargetId,
        config: fleet::FleetTargetConfig,
    ) -> Result<Result<fleet::TargetSnapshot, fleet::FleetDeliveryError>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::PutTarget { id, config, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn remove_target(
        &self,
        id: fleet::TargetId,
    ) -> Result<Result<bool, fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RemoveTarget { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn submit(
        &self,
        request: fleet::FleetDeliveryRequest,
    ) -> Result<Result<fleet::FleetSubmitOutcome, fleet::FleetDeliveryError>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Submit { request, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn node_command_request(
        &self,
        request: crate::fleet::owner::FleetNodeCommandRequest,
    ) -> Result<
        Result<crate::fleet::owner::FleetNodeCommandResolution, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::NodeCommandRequest { request, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub(crate) async fn begin_pending_dispatch(
        &self,
        pending: crate::fleet::owner::PendingDispatch,
    ) -> Result<(), RequestAdmissionClosed> {
        let (reply, _reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Begin {
                target_id: pending.target_id,
                dispatch_id: pending.dispatch_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    async fn dispatch_target_id(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
    ) -> Result<Result<fleet::TargetId, fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::DispatchTarget { dispatch_id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    async fn connection_target_id(
        &self,
        id: fleet::connection::ConnectionId,
    ) -> Result<Result<fleet::TargetId, fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::ConnectionTarget { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    async fn environment_target_id(
        &self,
        id: fleet::environment::EnvironmentId,
    ) -> Result<Result<fleet::TargetId, fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::EnvironmentTarget { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    async fn resource_target_id(
        &self,
        id: fleet::environment::ManagedResourceId,
    ) -> Result<Result<fleet::TargetId, fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_query(FleetQuery::ResourceTarget { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn begin_dispatch(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
    ) -> Result<
        Result<crate::fleet::owner::FleetDispatchResult, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let target_id = match self.dispatch_target_id(dispatch_id.clone()).await? {
            Ok(target_id) => target_id,
            Err(error) => return Ok(Err(error)),
        };
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Begin {
                target_id,
                dispatch_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn accept_dispatch(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Accept {
                dispatch_id,
                attempt,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn reject_dispatch(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Reject {
                dispatch_id,
                attempt,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn mark_dispatch_unknown(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Unknown {
                dispatch_id,
                attempt,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn authorize_replay(
        &self,
        command_id: fleet::command::CommandId,
        dispatch_id: fleet::outbox::DispatchId,
    ) -> Result<
        Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::Replay {
                command_id,
                dispatch_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn upsert_connection(
        &self,
        record: fleet::connection::ConnectionRecord,
    ) -> Result<
        Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::UpsertConnection { record, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn delete_connection(
        &self,
        id: fleet::connection::ConnectionId,
    ) -> Result<
        Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::DeleteConnection { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn begin_connection_probe(
        &self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::BeginConnectionProbe {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn run_connection_probe(
        &self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetConnectionLifecycleOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let target_id = match self.connection_target_id(id.clone()).await? {
            Ok(target_id) => target_id,
            Err(error) => return Ok(Err(error)),
        };
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RunConnectionProbe {
                target_id,
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn run_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let target_id = match self.environment_target_id(id.clone()).await? {
            Ok(target_id) => target_id,
            Err(error) => return Ok(Err(error)),
        };
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RunEnvironmentDeployment {
                target_id,
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn run_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let target_id = match self.environment_target_id(id.clone()).await? {
            Ok(target_id) => target_id,
            Err(error) => return Ok(Err(error)),
        };
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RunEnvironmentDeletion {
                target_id,
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn run_resource_provisioning(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let target_id = match self.resource_target_id(id.clone()).await? {
            Ok(target_id) => target_id,
            Err(error) => return Ok(Err(error)),
        };
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RunResourceProvisioning {
                target_id,
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn run_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let target_id = match self.resource_target_id(id.clone()).await? {
            Ok(target_id) => target_id,
            Err(error) => return Ok(Err(error)),
        };
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RunResourceDeletion {
                target_id,
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_connection_probe(
        &self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        outcome: fleet::connection::ProbeOutcome,
        message: Option<String>,
    ) -> Result<
        Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteConnectionProbe {
                id,
                command_id,
                outcome,
                message,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn register_environment(
        &self,
        record: fleet::environment::EnvironmentRecord,
    ) -> Result<
        Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RegisterEnvironment { record, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn register_resource(
        &self,
        request: crate::fleet::owner::ManagedResourceRegistrationRequest,
    ) -> Result<
        Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RegisterResource { request, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn upsert_node(
        &self,
        observation: fleet::topology::NodeObservation,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::UpsertNode { observation, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn upsert_agent(
        &self,
        observation: fleet::topology::AgentObservation,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::UpsertAgent { observation, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn write_credential(
        &self,
        request: crate::fleet::credentials::FleetCredentialWriteRequest,
    ) -> Result<
        Result<
            crate::fleet::credentials::FleetCredentialWriteOutcome,
            crate::fleet::credentials::FleetCredentialVaultError,
        >,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::WriteCredential { request, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn revoke_agent(
        &self,
        id: platform::endpoint::NativeAgentId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RevokeAgent { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn upsert_runtime(
        &self,
        observation: fleet::topology::RuntimeObservation,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::UpsertRuntime { observation, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn upsert_endpoint(
        &self,
        observation: fleet::topology::EndpointObservation,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::UpsertEndpoint { observation, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn retire_node(
        &self,
        id: fleet::topology::NodeId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RetireNode { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn begin_runtime_start(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::BeginRuntimeStart {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_runtime_start(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteRuntimeStart {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn begin_runtime_stop(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::BeginRuntimeStop {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_runtime_stop(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteRuntimeStop {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn retire_runtime(
        &self,
        id: fleet::topology::RuntimeId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RetireRuntime { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn drain_endpoint(
        &self,
        id: platform::endpoint::EndpointId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::DrainEndpoint { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn retire_endpoint(
        &self,
        id: platform::endpoint::EndpointId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RetireEndpoint { id, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn begin_endpoint_probe(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::BeginEndpointProbe {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_endpoint_probe(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        health: fleet::topology::EndpointHealth,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteEndpointProbe {
                id,
                command_id,
                health,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn begin_capability_sync(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::BeginCapabilitySync {
                id,
                command_id,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_capability_sync(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        sync: fleet::topology::CapabilitySync,
    ) -> Result<
        Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteCapabilitySync {
                id,
                command_id,
                sync,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn fail_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<
        Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::FailEnvironmentDeployment {
                id,
                command_id,
                phase,
                message,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn fail_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<
        Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::FailEnvironmentDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_resource_provisioning(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn complete_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::CompleteResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn fail_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<
        Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::FailResourceDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn authenticate_runtime_agent_ingress(
        &self,
        identity: fleet::store::AgentIngressIdentity,
    ) -> Result<
        Result<fleet::store::IngressAuthentication, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::AuthenticateRuntimeAgentIngress { identity, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn register_runtime_agent(
        &self,
        agent: fleet::runtime_agent::RuntimeAgent,
    ) -> Result<Result<(), fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RegisterRuntimeAgent { agent, reply })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn register_runtime_agent_command(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        queued_at: SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<Result<(), fleet::FleetDeliveryError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RegisterRuntimeAgentCommand {
                agent_id,
                correlation,
                queued_at,
                command_attempt,
                dispatch_attempt,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn record_runtime_agent_heartbeat(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
    ) -> Result<
        Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RecordRuntimeAgentHeartbeat {
                agent_id,
                heartbeat,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn record_runtime_agent_progress(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RecordRuntimeAgentProgress {
                agent_id,
                correlation,
                progress,
                reported_at,
                command_attempt,
                dispatch_attempt,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }

    pub async fn record_runtime_agent_result(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = oneshot::channel();
        self.owner
            .send_command(FleetCommand::RecordRuntimeAgentResult {
                agent_id,
                correlation,
                result,
                command_attempt,
                dispatch_attempt,
                reply,
            })
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))?;
        reply_rx
            .await
            .map_err(|_| RequestAdmissionClosed::new(HostPhase::ShutDown))
    }
}
