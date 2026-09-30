use platform::call::{CallContext, CallDetail, CallStatus};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::{
    abort::SessionAbortOutcome,
    approval::{PendingApprovalsOutcome, SessionApprovalOutcome},
    command::{SessionCommand, SessionEvictOutcome, SessionSendRequest},
    create::SessionCreateOutcome,
    delete::SessionDeleteOutcome,
    model_selection::SessionModelSelectionOutcome,
    query::SessionQuery,
    rename::SessionRenameOutcome,
    send::SessionSendOutcome,
    session_catalog::SessionCatalogOutcome,
    session_history::{SessionHistoryFailure, SessionHistoryOutcome},
    session_permission::{SessionPermissionAction, SessionPermissionOutcome},
    state::{SessionProvider, SessionView},
    timeline::{self, ContentOutcome},
};

/// Opaque references deliberately cannot expose a transcript, native path or credential-shaped ID.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsCallDetail {
    pub provider: Option<SessionProvider>,
    pub session_ref: Option<String>,
    pub native_session_ref: Option<String>,
    pub run_ref: Option<String>,
    pub outcome: Option<SessionsCallOutcome>,
    pub count: Option<usize>,
    pub seq: Option<u64>,
}

impl CallDetail for SessionsCallDetail {
    const MODULE: &'static str = "sessions";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionsCallOutcome {
    Queued,
    Started,
    Succeeded,
    Responded,
    Subscribed,
    Complete,
    Incomplete,
    NotFound,
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
    Protocol,
    Deadline,
}

#[derive(Clone)]
pub struct SessionCall {
    context: CallContext<SessionsCallDetail>,
    detail: SessionsCallDetail,
}

impl SessionCall {
    pub(crate) fn new(
        context: CallContext<SessionsCallDetail>,
        detail: SessionsCallDetail,
    ) -> Self {
        Self { context, detail }
    }

    pub(crate) async fn running(&self) -> Result<(), platform::call::CallLogError> {
        self.context.accepted().await?;
        self.context.running().await
    }

    pub(crate) async fn rejected(&self) {
        let mut detail = self.detail.clone();
        detail.outcome = Some(SessionsCallOutcome::Unavailable);
        if let Err(error) = self.context.finish(CallStatus::Rejected, &detail).await {
            audit_error(error);
        }
    }

    pub(crate) async fn finish<T: CallOutcome>(&self, outcome: &T) {
        let mut detail = self.detail.clone();
        let status = outcome.summarize(&mut detail);
        if let Err(error) = self.context.finish(status, &detail).await {
            audit_error(error);
        }
    }
}

fn audit_error(error: platform::call::CallLogError) {
    eprintln!("Sessions call audit: {error}");
}

pub(crate) async fn command_parts(
    command: SessionCommand,
) -> Result<(SessionCommand, Option<SessionCall>), ()> {
    match command {
        SessionCommand::Audited { command, call } => {
            // Drop the original reply on audit failure so the handle returns admission unavailable.
            call.running().await.map_err(audit_error)?;
            Ok((*command, Some(call)))
        }
        command => Ok((command, None)),
    }
}

pub(crate) async fn query_parts(
    query: SessionQuery,
) -> Result<(SessionQuery, Option<SessionCall>), ()> {
    match query {
        SessionQuery::Audited { query, call } => {
            call.running().await.map_err(audit_error)?;
            Ok((*query, Some(call)))
        }
        query => Ok((query, None)),
    }
}

pub(crate) async fn reply<T: CallOutcome>(
    call: Option<&SessionCall>,
    reply: oneshot::Sender<T>,
    outcome: T,
) {
    if let Some(call) = call {
        call.finish(&outcome).await;
    }
    let _ = reply.send(outcome);
}

fn reference(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

impl SessionsCallDetail {
    fn session(provider: SessionProvider, session_key: &str, native_id: Option<&str>) -> Self {
        Self {
            provider: Some(provider),
            session_ref: Some(reference(session_key)),
            native_session_ref: native_id.map(reference),
            ..Self::default()
        }
    }

    fn view(&mut self, view: &SessionView) {
        self.provider = Some(view.identity.provider());
        self.session_ref = Some(reference(view.identity.session_key()));
        self.native_session_ref = view.endpoint_session_id.as_deref().map(reference);
        self.count = match &view.items {
            crate::domain::model::SessionFact::Complete(items)
            | crate::domain::model::SessionFact::Incomplete { facts: items, .. } => {
                Some(items.len())
            }
            crate::domain::model::SessionFact::Unavailable
            | crate::domain::model::SessionFact::Unknown => None,
        };
        self.seq = Some(view.seq);
    }

    fn outcome(&mut self, outcome: SessionsCallOutcome) -> CallStatus {
        use SessionsCallOutcome::*;
        self.outcome = Some(outcome);
        match outcome {
            Queued | Started | Succeeded | Responded | Subscribed | Complete | Incomplete
            | NotFound => CallStatus::Succeeded,
            Rejected | Unsupported => CallStatus::Rejected,
            Unknown => CallStatus::Unknown,
            Unavailable | Protocol | Deadline => CallStatus::Failed,
        }
    }
}

impl SessionCommand {
    pub(crate) fn call_detail(&self) -> Option<(&'static str, SessionsCallDetail)> {
        use SessionCommand::*;
        let (command, detail) = match self {
            Evict { session_key, .. } => (
                "sessions.evict",
                SessionsCallDetail {
                    session_ref: Some(reference(session_key)),
                    ..SessionsCallDetail::default()
                },
            ),
            Create { command, .. } => (
                "sessions.create",
                SessionsCallDetail::session(
                    command.provider(),
                    command.session_key(),
                    Some(command.endpoint_session_id()),
                ),
            ),
            Send {
                request: SessionSendRequest::Session { command, .. },
            } => {
                let mut detail = SessionsCallDetail::session(
                    command.endpoint.provider(),
                    &command.session_key,
                    command.endpoint_session_id.as_deref(),
                );
                detail.count = Some(command.attachments.len());
                ("sessions.send", detail)
            }
            Delete { command, .. } => (
                "sessions.delete",
                SessionsCallDetail::session(SessionProvider::OpenClaw, &command.session_key, None),
            ),
            Rename { command, .. } => (
                "sessions.rename",
                SessionsCallDetail::session(SessionProvider::OpenClaw, &command.session_key, None),
            ),
            Approval { command, .. } => (
                "sessions.approvals.respond",
                SessionsCallDetail {
                    provider: Some(command.endpoint.provider()),
                    native_session_ref: Some(reference(&command.session_id)),
                    ..SessionsCallDetail::default()
                },
            ),
            ModelSelection { command, .. } => (
                "sessions.model",
                SessionsCallDetail::session(
                    command.endpoint.provider(),
                    &command.session_key,
                    command.endpoint_session_id.as_deref(),
                ),
            ),
            Permission { command, .. } => (
                match command.action() {
                    SessionPermissionAction::Get => "sessions.permission.get",
                    SessionPermissionAction::Set { .. } => "sessions.permission.set",
                },
                SessionsCallDetail::session(
                    command.endpoint.provider(),
                    command.session_key(),
                    None,
                ),
            ),
            Ensure { .. } | Ingest { .. } | ConfigurePrivateResolver { .. } | Audited { .. } => {
                return None;
            }
        };
        Some((command, detail))
    }
}

impl SessionQuery {
    pub(crate) fn call_detail(&self) -> Option<(&'static str, SessionsCallDetail)> {
        use SessionQuery::*;
        Some(match self {
            BoundaryOutcome {
                command, detail, ..
            } => (*command, detail.clone()),
            EventsSubscribed { .. } => ("sessions.events", SessionsCallDetail::default()),
            ListSessions { .. } => ("sessions.listCached", SessionsCallDetail::default()),
            GetSession { session_key, .. } => (
                "sessions.getCached",
                SessionsCallDetail {
                    session_ref: Some(reference(session_key)),
                    ..SessionsCallDetail::default()
                },
            ),
            Abort { command, .. } => {
                let mut detail = SessionsCallDetail::session(
                    command.endpoint.provider(),
                    &command.session_key,
                    command.endpoint_session_id.as_deref(),
                );
                detail.run_ref = command.run_id.as_deref().map(reference);
                detail.count = command.approval_ids.as_ref().map(Vec::len);
                ("sessions.abort", detail)
            }
            PendingApprovals { command, .. } => (
                "sessions.approvals.list",
                SessionsCallDetail {
                    provider: Some(command.endpoint.provider()),
                    native_session_ref: Some(reference(&command.session_id)),
                    ..SessionsCallDetail::default()
                },
            ),
            Timeline { command, .. } => (
                match command.operation() {
                    timeline::Operation::Load => "sessions.load",
                    timeline::Operation::Window => "sessions.window",
                },
                SessionsCallDetail::session(
                    command.session_provider(),
                    command.session_key(),
                    command.endpoint_session_id(),
                ),
            ),
            Content { command, .. } => (
                "sessions.content",
                SessionsCallDetail::session(
                    command.session_provider(),
                    command.session_key(),
                    command.endpoint_session_id(),
                ),
            ),
            Catalog { command, .. } => (
                "sessions.list",
                SessionsCallDetail {
                    provider: Some(
                        crate::endpoint::NativeEndpoint::from_runtime_endpoint(
                            command.endpoint().clone(),
                        )
                        .provider(),
                    ),
                    ..SessionsCallDetail::default()
                },
            ),
            History { command, .. } => (
                "sessions.history",
                SessionsCallDetail::session(
                    crate::endpoint::NativeEndpoint::from_runtime_endpoint(
                        command.endpoint().clone(),
                    )
                    .provider(),
                    command.session_key(),
                    command.endpoint_session_id(),
                ),
            ),
            Audited { .. } => return None,
        })
    }
}

pub(crate) trait CallOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus;
}

impl CallOutcome for SessionsCallOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        detail.outcome(*self)
    }
}

impl CallOutcome for () {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        detail.outcome(SessionsCallOutcome::Subscribed)
    }
}

macro_rules! simple_outcome {
    ($ty:ty, $($pattern:pat => $outcome:ident),+ $(,)?) => {
        impl CallOutcome for $ty {
            fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
                detail.outcome(match self { $($pattern => SessionsCallOutcome::$outcome),+ })
            }
        }
    };
}

simple_outcome!(SessionAbortOutcome,
    SessionAbortOutcome::Succeeded => Succeeded, SessionAbortOutcome::Rejected => Rejected,
    SessionAbortOutcome::Unknown => Unknown, SessionAbortOutcome::Unsupported => Unsupported,
    SessionAbortOutcome::Unavailable => Unavailable);
simple_outcome!(SessionApprovalOutcome,
    SessionApprovalOutcome::Responded => Responded, SessionApprovalOutcome::Rejected => Rejected,
    SessionApprovalOutcome::Unknown => Unknown, SessionApprovalOutcome::Unsupported => Unsupported,
    SessionApprovalOutcome::Unavailable => Unavailable);
simple_outcome!(SessionDeleteOutcome,
    SessionDeleteOutcome::Succeeded => Succeeded, SessionDeleteOutcome::TargetRejected => Rejected,
    SessionDeleteOutcome::Unknown => Unknown);
simple_outcome!(SessionRenameOutcome,
    SessionRenameOutcome::Succeeded => Succeeded, SessionRenameOutcome::TargetRejected => Rejected,
    SessionRenameOutcome::Unknown => Unknown);
simple_outcome!(SessionEvictOutcome,
    SessionEvictOutcome::Evicted => Succeeded, SessionEvictOutcome::NotFound => NotFound,
    SessionEvictOutcome::Failed => Unavailable);
simple_outcome!(SessionModelSelectionOutcome,
    SessionModelSelectionOutcome::Succeeded { .. } => Succeeded,
    SessionModelSelectionOutcome::TargetRejected { .. } => Rejected,
    SessionModelSelectionOutcome::OutcomeUnknown => Unknown,
    SessionModelSelectionOutcome::Unsupported => Unsupported,
    SessionModelSelectionOutcome::Unavailable => Unavailable);

impl CallOutcome for SessionSendOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        use SessionSendOutcome::*;
        let outcome = match self {
            Queued { run_id } => {
                detail.run_ref = Some(reference(run_id));
                SessionsCallOutcome::Queued
            }
            Succeeded { run_id, .. } => {
                detail.run_ref = Some(reference(run_id));
                SessionsCallOutcome::Started
            }
            Rejected => SessionsCallOutcome::Rejected,
            Unknown => SessionsCallOutcome::Unknown,
            Unsupported => SessionsCallOutcome::Unsupported,
            Unavailable => SessionsCallOutcome::Unavailable,
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for SessionCreateOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Succeeded(view) => {
                detail.view(view);
                SessionsCallOutcome::Succeeded
            }
            Self::TargetRejected => SessionsCallOutcome::Rejected,
            Self::Unknown => SessionsCallOutcome::Unknown,
            Self::Unavailable => SessionsCallOutcome::Unavailable,
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for Vec<SessionView> {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        detail.count = Some(self.len());
        detail.outcome(SessionsCallOutcome::Complete)
    }
}

impl CallOutcome for Option<SessionView> {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Some(view) => {
                detail.view(view);
                SessionsCallOutcome::Complete
            }
            None => SessionsCallOutcome::NotFound,
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for PendingApprovalsOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Found(approvals) => {
                detail.count = Some(approvals.approvals.len());
                SessionsCallOutcome::Complete
            }
            Self::Rejected => SessionsCallOutcome::Rejected,
            Self::Unknown => SessionsCallOutcome::Unknown,
            Self::Unsupported => SessionsCallOutcome::Unsupported,
            Self::Unavailable => SessionsCallOutcome::Unavailable,
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for timeline::Outcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Complete(view) => {
                detail.view(view);
                SessionsCallOutcome::Complete
            }
            Self::Incomplete(view) => {
                detail.view(view);
                SessionsCallOutcome::Incomplete
            }
            Self::Unavailable(failure) => timeline_failure(failure.reason()),
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for ContentOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Complete(chunk) => {
                detail.count = Some(chunk.text.len());
                SessionsCallOutcome::Complete
            }
            Self::Unavailable(reason) => timeline_failure(*reason),
        };
        detail.outcome(outcome)
    }
}

fn timeline_failure(reason: timeline::UnavailableReason) -> SessionsCallOutcome {
    use timeline::UnavailableReason::*;
    match reason {
        RuntimeUnsupported | SessionOpsUnavailable => SessionsCallOutcome::Unsupported,
        RuntimeTargetRejected
        | OpenClawReadTargetRejected
        | MatchaIdentityInvalid
        | OpenClawBindingInvalid
        | OpenClawSessionKeyInvalid
        | OpenClawIdentityMismatch
        | OpenClawIdentityInvalid => SessionsCallOutcome::Rejected,
        RuntimeUnknown | MatchaReadUnknown | OpenClawReadUnknownResponse => {
            SessionsCallOutcome::Unknown
        }
        OpenClawReadRequestDeadline => SessionsCallOutcome::Deadline,
        OpenClawReadProtocol | MatchaProjectionInvalid | OpenClawProjectionInvalid => {
            SessionsCallOutcome::Protocol
        }
        _ => SessionsCallOutcome::Unavailable,
    }
}

impl CallOutcome for SessionCatalogOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Listed(catalog) => {
                detail.count = Some(catalog.sessions.len());
                SessionsCallOutcome::Complete
            }
            Self::Unavailable => SessionsCallOutcome::Unavailable,
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for SessionHistoryOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Loaded(view) => {
                detail.count = Some(view.messages.len());
                SessionsCallOutcome::Complete
            }
            Self::Failed(SessionHistoryFailure::Rejected) => SessionsCallOutcome::Rejected,
            Self::Failed(SessionHistoryFailure::Protocol) => SessionsCallOutcome::Protocol,
            Self::Failed(SessionHistoryFailure::Unavailable) => SessionsCallOutcome::Unavailable,
            Self::Failed(SessionHistoryFailure::Deadline) => SessionsCallOutcome::Deadline,
        };
        detail.outcome(outcome)
    }
}

impl CallOutcome for SessionPermissionOutcome {
    fn summarize(&self, detail: &mut SessionsCallDetail) -> CallStatus {
        let outcome = match self {
            Self::Projection(projection) if projection.supported => SessionsCallOutcome::Complete,
            Self::Projection(_) => SessionsCallOutcome::Unsupported,
            Self::Unavailable => SessionsCallOutcome::Unavailable,
        };
        detail.outcome(outcome)
    }
}
