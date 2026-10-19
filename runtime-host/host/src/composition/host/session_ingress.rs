use std::collections::{HashMap, VecDeque};

use foundation::execution::OwnedTask;
use futures_util::{StreamExt, stream::FuturesUnordered};
use sessions_module::{
    SessionHandle, SessionIngressProducer,
    command::{SessionIngress, SessionIngressEvent, SessionIngestOutcome, session_identity_lane_key},
    state::SessionIdentity,
};
use tokio::sync::{mpsc, oneshot};

struct PendingIngress {
    identity: SessionIdentity,
    event: SessionIngress,
    receipt: Option<oneshot::Sender<bool>>,
}

pub(in crate::composition::host) fn forward(
    scope: &mut foundation::lifecycle::ModuleScope,
    sessions: SessionHandle,
    effect_id: &'static str,
    mut events: mpsc::Receiver<SessionIngressEvent>,
) {
    let producer = sessions
        .ingress_producer()
        .expect("session ingress must be registered before source shutdown");
    let (mut task, _) = OwnedTask::spawn(move |cancellation| async move {
        let capacity = events.max_capacity();
        let mut pending = HashMap::<String, VecDeque<PendingIngress>>::new();
        let mut running = FuturesUnordered::new();
        let mut resident = 0;
        let mut receiving = true;
        while receiving || !running.is_empty() {
            tokio::select! {
                biased;
                _ = cancellation.cancelled(), if receiving => receiving = false,
                _ = producer.stopped(), if receiving => receiving = false,
                Some((key, available)) = running.next(), if !running.is_empty() => {
                    resident -= 1;
                    receiving &= available;
                    // Only the completed identity advances, after its outcome and receipt.
                    let queue = pending.get_mut(&key).expect("active ingress identity queue");
                    if let Some(event) = queue.pop_front() {
                        running.push(ingest(&producer, effect_id, key, event));
                    } else {
                        pending.remove(&key);
                    }
                }
                event = events.recv(), if receiving && resident < capacity => {
                    let Some(mut event) = event else {
                        receiving = false;
                        continue;
                    };
                    let receipt = event.take_receipt();
                    let (identity, event) = event.into_parts();
                    let key = session_identity_lane_key(&identity);
                    let event = PendingIngress { identity, event, receipt };
                    // Running and queued events share the receiver's existing capacity.
                    resident += 1;
                    if let Some(queue) = pending.get_mut(&key) {
                        queue.push_back(event);
                    } else {
                        pending.insert(key.clone(), VecDeque::new());
                        running.push(ingest(&producer, effect_id, key, event));
                    }
                }
            }
        }
        // Keep the receiver until the source/consumer shutdown barriers have joined.
        events
    });
    scope.register_event_subscription(effect_id, move || async move {
        let _ = task.cancel_and_join().await;
    });
}

async fn ingest(
    producer: &SessionIngressProducer,
    effect_id: &'static str,
    key: String,
    ingress: PendingIngress,
) -> (String, bool) {
    let PendingIngress { identity, event, receipt } = ingress;
    let context = sessions_module::trace::enabled().then(|| serde_json::json!({
        "identity": sessions_module::trace::identity_shape(&identity),
        "generation": event.binding().generation(), "sourceEpoch": event.binding().source_epoch(),
        "nativeCursor": match &event { SessionIngress::Event(event) => event.cursor, SessionIngress::ObservationFailed { .. } | SessionIngress::RestoredTerminal { .. } => None },
        "runHash": match &event { SessionIngress::Event(event) => event.run_id.as_deref().map(sessions_module::trace::fingerprint), SessionIngress::RestoredTerminal { terminal, .. } => Some(sessions_module::trace::fingerprint(&terminal.run_id)), SessionIngress::ObservationFailed { .. } => None },
    }));
    let outcome = producer.ingest_ingress_event(SessionIngressEvent::from_ingress(identity, event)).await;
    if sessions_module::trace::enabled() {
        use sessions_module::trace;
        let summary = match &outcome {
            Ok(SessionIngestOutcome::Applied(delta)) => serde_json::json!({
                "outcome": "applied", "identity": trace::identity_shape(&delta.identity),
                "epoch": delta.epoch, "seq": delta.seq, "cursor": delta.cursor,
            }),
            Ok(SessionIngestOutcome::TerminalRestored) => serde_json::json!({ "outcome": "terminal_restored" }),
            Ok(SessionIngestOutcome::Consumed { cursor }) => serde_json::json!({ "outcome": "consumed", "nativeCursor": cursor }),
            Ok(SessionIngestOutcome::Duplicate { cursor }) => serde_json::json!({ "outcome": "duplicate", "nativeCursor": cursor }),
            Ok(SessionIngestOutcome::Stale { cursor, received }) => serde_json::json!({ "outcome": "stale", "nativeCursor": cursor, "receivedNativeCursor": received }),
            Ok(SessionIngestOutcome::Gap { expected, received }) => serde_json::json!({ "outcome": "gap", "expectedNativeCursor": expected, "receivedNativeCursor": received }),
            Ok(SessionIngestOutcome::Rejected { .. }) => serde_json::json!({ "outcome": "rejected" }),
            Ok(SessionIngestOutcome::RuntimeNotFound) => serde_json::json!({ "outcome": "runtime_not_found" }),
            Ok(SessionIngestOutcome::RuntimeNoSessionSupport) => serde_json::json!({ "outcome": "runtime_no_session_support" }),
            Err(()) => serde_json::json!({ "outcome": "owner_unavailable" }),
        };
        trace::log_unscoped("host.ingress.outcome", || serde_json::json!({
            "ingressHash": trace::fingerprint(effect_id), "event": context,
            "receiptPresent": receipt.is_some(), "result": summary,
        }));
    }
    if let Some(receipt) = receipt {
        let accepted = matches!(
            &outcome,
            Ok(SessionIngestOutcome::Applied(_) | SessionIngestOutcome::Consumed { .. } | SessionIngestOutcome::TerminalRestored)
        );
        let delivered = receipt.send(accepted).is_ok();
        if sessions_module::trace::enabled() {
            sessions_module::trace::log_unscoped("host.ingress.receipt", || serde_json::json!({
                "ingressHash": sessions_module::trace::fingerprint(effect_id), "event": context,
                "accepted": accepted, "delivered": delivered,
            }));
        }
    }
    (key, outcome.is_ok())
}
