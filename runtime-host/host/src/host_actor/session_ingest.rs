use matcha_agent::{
    peer::{RendererEventEnvelope, SessionSubscriptionItem},
    session::recovery::RecoveryReason as MatchaRecoveryReason,
};
use openclaw::port::CanonicalIngressResult;

use crate::{
    Host,
    composition::HostEvent,
    sessions::{
        command::SessionEvent,
        matcha::matcha_event_changes,
        openclaw::openclaw_canonical_changes,
        state::{
            RecoveryReason, SessionChange, SessionIdentity, SessionProvider, SessionSourceBinding,
        },
    },
};

pub(super) enum SessionIngestAction {
    Continue,
    Shutdown,
}

pub(super) async fn handle(host: &Host, event: &HostEvent) -> SessionIngestAction {
    match event {
        HostEvent::OpenClawCanonical(ingress) => ingest_openclaw_canonical(host, ingress).await,
        HostEvent::Matcha(SessionSubscriptionItem::Event(event)) => {
            ingest_matcha_event(host, event).await
        }
        HostEvent::Matcha(SessionSubscriptionItem::Recovery {
            route_key,
            session_key,
            run_id,
            recovery,
        }) => ingest_matcha_recovery(host, route_key, session_key, run_id, recovery).await,
        _ => SessionIngestAction::Continue,
    }
}

async fn ingest_openclaw_canonical(
    host: &Host,
    ingress: &CanonicalIngressResult,
) -> SessionIngestAction {
    let (session_key, binding, run_id, cursor, changes) = match ingress {
        CanonicalIngressResult::Produced(delta) => {
            let session_key = delta.session_key().as_str().to_owned();
            let route_key = delta.route_key().map(str::to_owned);
            let binding =
                SessionSourceBinding::new(session_key.clone(), route_key, delta.source_epoch())
                    .expect("OpenClaw canonical ingress must contain a valid session binding");
            let run_id = delta.run_id().map(|id| id.as_str().to_owned());
            let changes =
                openclaw_canonical_changes(delta.changes(), delta.run_id().map(|id| id.as_str()));
            (session_key, binding, run_id, delta.source_cursor(), changes)
        }
        CanonicalIngressResult::Unknown { provenance } => {
            let session_key = provenance.session_key().as_str().to_owned();
            let binding = SessionSourceBinding::new(
                session_key.clone(),
                provenance.route_key().map(str::to_owned),
                provenance.source_epoch(),
            )
            .expect("OpenClaw canonical provenance must contain a valid session binding");
            let changes = vec![SessionChange::RecoveryRequired {
                reason: RecoveryReason::NativeUnknown,
            }];
            (
                session_key,
                binding,
                None,
                provenance.source_cursor(),
                changes,
            )
        }
    };

    let identity = SessionIdentity::new(session_key, SessionProvider::OpenClaw, None)
        .expect("OpenClaw canonical ingress must contain a valid session identity");
    let event = SessionEvent {
        binding,
        run_id,
        cursor,
        changes,
    };
    let _ = host.sessions().ingest_event(identity, event).await;
    SessionIngestAction::Continue
}

async fn ingest_matcha_event(host: &Host, event: &RendererEventEnvelope) -> SessionIngestAction {
    let route_key = event.route_key().to_owned();
    let session_key = event.session_key().to_owned();
    let run_id = event.run_id().to_owned();
    let cursor = event.source_cursor();
    let source_epoch = event.source_epoch();
    let Some(changes) = matcha_event_changes(event.clone()) else {
        return SessionIngestAction::Continue;
    };
    let Some(binding) =
        SessionSourceBinding::new(session_key.clone(), Some(route_key), source_epoch)
    else {
        return SessionIngestAction::Continue;
    };
    let identity = SessionIdentity::new(session_key, SessionProvider::MatchaAgent, None)
        .expect("Matcha renderer event must contain a valid session identity");
    let event = SessionEvent {
        binding,
        run_id: Some(run_id),
        cursor: Some(cursor),
        changes,
    };
    let _ = host.sessions().ingest_event(identity, event).await;
    SessionIngestAction::Continue
}

async fn ingest_matcha_recovery(
    host: &Host,
    route_key: &str,
    session_key: &str,
    run_id: &str,
    recovery: &matcha_agent::session::recovery::SessionRecovery,
) -> SessionIngestAction {
    let Some(cursor) = recovery.native_cursor() else {
        return SessionIngestAction::Shutdown;
    };
    let source_cursor = cursor.sequence().get();
    let Some(binding) = SessionSourceBinding::new(
        session_key.to_owned(),
        Some(route_key.to_owned()),
        recovery.source_epoch(),
    ) else {
        return SessionIngestAction::Shutdown;
    };
    let identity = SessionIdentity::new(session_key.to_owned(), SessionProvider::MatchaAgent, None)
        .expect("Matcha recovery must contain a valid session identity");
    let event = SessionEvent {
        binding,
        run_id: Some(run_id.to_owned()),
        cursor: Some(source_cursor),
        changes: vec![SessionChange::RecoveryRequired {
            reason: matcha_recovery_reason(recovery.reason()),
        }],
    };
    let _ = host.sessions().ingest_event(identity, event).await;
    SessionIngestAction::Continue
}

fn matcha_recovery_reason(reason: &MatchaRecoveryReason) -> RecoveryReason {
    match reason {
        MatchaRecoveryReason::CursorGap { .. } => RecoveryReason::CursorGap,
        MatchaRecoveryReason::CursorStale { .. } => RecoveryReason::CursorStale,
        MatchaRecoveryReason::EventOverflow | MatchaRecoveryReason::BroadcastLagged { .. } => {
            RecoveryReason::EventOverflow
        }
        MatchaRecoveryReason::ConnectionClosed { .. } | MatchaRecoveryReason::Restart => {
            RecoveryReason::NativeUnavailable
        }
        MatchaRecoveryReason::ReplayBoundary { .. }
        | MatchaRecoveryReason::ProjectionRejected { .. } => RecoveryReason::NativeUnknown,
    }
}
