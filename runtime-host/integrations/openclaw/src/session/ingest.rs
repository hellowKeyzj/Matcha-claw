use std::{
    collections::HashMap,
    num::NonZeroUsize,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::mpsc;

use crate::gateway::{
    ingress::{GatewayEpoch, Ingress, IngressError, IngressEvent},
    wire::GatewayEvent,
};

use super::{
    events::{SessionEvent, send_lifecycle},
    projection::{CanonicalIngressResult, CanonicalSessionDeltaProducer},
    protocol::{
        ChatState, SessionEventEnvelope, SessionEventKind, SessionKey, decode_session_event,
    },
};

const INGRESS_CAPACITY: usize = 256;

/// Consumes a socket's decoded Gateway events, sequences them through the
/// shared [`Ingress`], and fans each verified event out to the lifecycle sink
/// and the canonical-delta sink.
pub(crate) struct SessionEventIngest {
    ingress: Arc<Ingress>,
    next_epoch: AtomicU64,
    route_keys: Arc<Mutex<HashMap<SessionKey, String>>>,
    canonical_events: mpsc::Sender<CanonicalIngressResult>,
}

impl SessionEventIngest {
    pub(crate) fn new(
        events: mpsc::Sender<SessionEvent>,
        canonical_events: mpsc::Sender<CanonicalIngressResult>,
    ) -> Self {
        let (ingress, receiver) = Ingress::new(NonZeroUsize::new(INGRESS_CAPACITY).unwrap());
        let route_keys = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(project_ingress(
            receiver,
            events,
            canonical_events.clone(),
            Arc::clone(&route_keys),
        ));
        Self {
            ingress: Arc::new(ingress),
            next_epoch: AtomicU64::new(0),
            route_keys,
            canonical_events,
        }
    }

    pub(crate) fn register_route(&self, session_key: SessionKey, route_key: String) {
        self.route_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_key, route_key);
    }

    pub(crate) fn unregister_route(&self, session_key: &SessionKey) {
        self.route_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_key);
    }

    /// Drives one socket's event stream through the ingress. Each call is a new
    /// connection epoch, so a reconnect advances the shared cursor instead of
    /// replaying the previous socket's tail.
    pub(crate) fn forward(self: &Arc<Self>, events: mpsc::Receiver<GatewayEvent>) {
        let ingest = Arc::clone(self);
        tokio::spawn(async move {
            let epoch = ingest.begin_next_epoch();
            let mut events = events;
            while let Some(event) = events.recv().await {
                let Ok(Some(envelope)) = decode_session_event(event) else {
                    continue;
                };
                let session_key = envelope.session_key.clone();
                match ingest.ingress.try_ingest(epoch, envelope) {
                    Ok(()) | Err(IngressError::StaleEpoch) => {}
                    Err(error) => {
                        ingest
                            .publish_recovery(session_key, Some(epoch), error)
                            .await
                    }
                }
            }
        });
    }

    fn begin_next_epoch(&self) -> GatewayEpoch {
        let value = self.next_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        let epoch = GatewayEpoch::try_new(value).expect("epoch counter never yields zero");
        self.ingress
            .begin_epoch(epoch)
            .expect("epoch counter is monotonic");
        epoch
    }

    async fn publish_recovery(
        &self,
        session_key: SessionKey,
        epoch: Option<GatewayEpoch>,
        error: IngressError,
    ) {
        let route_key = self
            .route_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&session_key)
            .cloned();
        let recovery =
            CanonicalSessionDeltaProducer::from_ingress_error(session_key, route_key, epoch, error);
        let _ = self
            .canonical_events
            .send(CanonicalIngressResult::Produced(recovery))
            .await;
    }
}

async fn project_ingress(
    mut receiver: mpsc::Receiver<IngressEvent>,
    events: mpsc::Sender<SessionEvent>,
    canonical_events: mpsc::Sender<CanonicalIngressResult>,
    route_keys: Arc<Mutex<HashMap<SessionKey, String>>>,
) {
    while let Some(ingress_event) = receiver.recv().await {
        let epoch = ingress_event.epoch();
        let envelope = ingress_event.event();
        let _ = send_lifecycle(&events, envelope, epoch);
        let route_key = route_key_for(envelope, &route_keys);
        if let Some(delta) =
            CanonicalSessionDeltaProducer::from_native_event(envelope, Some(epoch), route_key)
        {
            let _ = canonical_events
                .send(CanonicalIngressResult::Produced(delta))
                .await;
        }
        if should_clear_route_key(envelope) {
            clear_route_key(envelope, &route_keys);
        }
    }
}

fn route_key_for(
    envelope: &SessionEventEnvelope,
    route_keys: &Mutex<HashMap<SessionKey, String>>,
) -> Option<String> {
    route_keys
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&envelope.session_key)
        .cloned()
}

fn should_clear_route_key(envelope: &SessionEventEnvelope) -> bool {
    matches!(envelope.kind, SessionEventKind::Chat)
        && envelope.chat.as_ref().is_some_and(|chat| {
            matches!(
                chat.state,
                ChatState::Final | ChatState::Aborted | ChatState::Error
            )
        })
}

fn clear_route_key(
    envelope: &SessionEventEnvelope,
    route_keys: &Mutex<HashMap<SessionKey, String>>,
) {
    route_keys
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&envelope.session_key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::protocol::{ChatEvent, RunId};

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn run(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn envelope(run_id: &str, state: ChatState) -> SessionEventEnvelope {
        let session_key = session_key();
        let run_id = run(run_id);
        SessionEventEnvelope {
            gateway_sequence: Some(1),
            kind: SessionEventKind::Chat,
            session_key: session_key.clone(),
            run_id: Some(run_id.clone()),
            message_id: None,
            embedded_message_id: None,
            chat: Some(ChatEvent {
                run_id,
                session_key,
                sequence: 1,
                state,
                delta_text: Some("delta".to_owned()),
                replace: false,
                message_text: None,
                error_kind: None,
                stop_reason: None,
            }),
            activity: None,
        }
    }

    #[test]
    fn route_key_uses_session_key_not_run_id() {
        let route_keys = Mutex::new(HashMap::from([(
            session_key(),
            "renderer-route:session".to_owned(),
        )]));

        assert_eq!(
            route_key_for(&envelope("native-run", ChatState::Delta), &route_keys).as_deref(),
            Some("renderer-route:session")
        );
    }

    #[test]
    fn terminal_chat_clears_session_route() {
        let route_keys = Mutex::new(HashMap::from([(
            session_key(),
            "renderer-route:session".to_owned(),
        )]));

        let terminal = envelope("native-run", ChatState::Final);
        assert!(should_clear_route_key(&terminal));
        clear_route_key(&terminal, &route_keys);

        assert_eq!(
            route_key_for(&envelope("another-run", ChatState::Delta), &route_keys),
            None
        );
    }
}
