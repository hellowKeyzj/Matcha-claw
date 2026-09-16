use std::collections::HashMap;

use tokio::sync::mpsc;

use crate::gateway::ingress::GatewayEpoch;

use super::{
    projection::{CanonicalIngressResult, CanonicalRecoveryReason},
    protocol::{SessionEventEnvelope, SessionKey},
    reducer::SessionReducerActor,
};

pub(crate) struct EventRouter {
    actors: HashMap<SessionKey, SessionReducerActor>,
    canonical_events: mpsc::Sender<CanonicalIngressResult>,
}

impl EventRouter {
    pub(crate) fn new(canonical_events: mpsc::Sender<CanonicalIngressResult>) -> Self {
        Self {
            actors: HashMap::new(),
            canonical_events,
        }
    }

    pub(crate) async fn route(
        &mut self,
        event: SessionEventEnvelope,
        epoch: GatewayEpoch,
        route_key: Option<String>,
    ) {
        let result = {
            let session_key = event.session_key.clone();
            let actor = self
                .actors
                .entry(session_key.clone())
                .or_insert_with(|| SessionReducerActor::new(session_key));
            actor.reduce(event, Some(epoch), route_key)
        };

        if let Some(result) = result {
            let _ = self.canonical_events.send(result).await;
        }
    }

    pub(crate) async fn recover(
        &mut self,
        session_key: SessionKey,
        epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
        reason: CanonicalRecoveryReason,
    ) {
        let result = self
            .actors
            .entry(session_key.clone())
            .or_insert_with(|| SessionReducerActor::new(session_key))
            .recover(epoch, route_key, reason);
        let _ = self.canonical_events.send(result).await;
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use super::*;
    use crate::session::{
        projection::{AssistantTurnChunkKind, CanonicalSessionChange},
        protocol::{ChatEvent, ChatState, RunId, SessionEventKind},
    };

    fn session_key(value: &str) -> SessionKey {
        SessionKey::try_new(value).unwrap()
    }

    fn run_id(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn gateway_epoch(value: u64) -> GatewayEpoch {
        GatewayEpoch::try_new(value).unwrap()
    }

    fn chat_delta(session: &str, run: &str, sequence: u64, text: &str) -> SessionEventEnvelope {
        let session_key = session_key(session);
        let run_id = run_id(run);
        SessionEventEnvelope {
            gateway_sequence: Some(sequence),
            kind: SessionEventKind::Chat,
            session_key: session_key.clone(),
            run_id: Some(run_id.clone()),
            message_id: None,
            embedded_message_id: None,
            chat: Some(ChatEvent {
                run_id,
                session_key,
                sequence,
                state: ChatState::Delta,
                status_phase: None,
                delta_text: Some(text.to_owned()),
                replace: false,
                message_text: None,
                message_thinking: None,
                error_kind: None,
                error_message: None,
                stop_reason: None,
                error_detail: None,
            }),
            activity: None,
            approval: None,
        }
    }

    fn produced(result: CanonicalIngressResult) -> super::super::projection::CanonicalSessionDelta {
        let CanonicalIngressResult::Produced(delta) = result else {
            panic!("expected produced canonical event");
        };
        delta
    }

    #[tokio::test]
    async fn routes_sessions_independently_and_sends_canonical_events() {
        let (canonical_events, mut received_events) = mpsc::channel(4);
        let mut router = EventRouter::new(canonical_events);

        router
            .route(
                chat_delta("agent:main:session-1", "run-1", 1, "one"),
                gateway_epoch(1),
                Some("route-1".to_owned()),
            )
            .await;
        router
            .route(
                chat_delta("agent:main:session-2", "run-2", 1, "two"),
                gateway_epoch(1),
                Some("route-2".to_owned()),
            )
            .await;
        assert_eq!(router.actors.len(), 2);

        let first = produced(received_events.recv().await.unwrap());
        assert_eq!(first.session_key().as_str(), "agent:main:session-1");
        assert_eq!(first.route_key(), Some("route-1"));
        assert!(matches!(
            first.changes(),
            [CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                kind: AssistantTurnChunkKind::Text,
                text,
                ..
            }] if run_id.as_str() == "run-1" && text == "one"
        ));

        let second = produced(received_events.recv().await.unwrap());
        assert_eq!(second.session_key().as_str(), "agent:main:session-2");
        assert_eq!(second.route_key(), Some("route-2"));
        assert!(matches!(
            second.changes(),
            [CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                kind: AssistantTurnChunkKind::Text,
                text,
                ..
            }] if run_id.as_str() == "run-2" && text == "two"
        ));
        assert!(received_events.try_recv().is_err());
    }
}
