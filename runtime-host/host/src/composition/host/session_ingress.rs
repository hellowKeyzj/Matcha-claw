use foundation::execution::OwnedTask;
use sessions_module::{
    SessionHandle,
    command::{SessionIngressEvent, SessionIngestOutcome},
};
use tokio::sync::mpsc;

pub(in crate::composition::host) fn forward(
    scope: &mut foundation::lifecycle::ModuleScope,
    sessions: SessionHandle,
    effect_id: &'static str,
    mut events: mpsc::Receiver<SessionIngressEvent>,
) {
    let (mut task, _) = OwnedTask::spawn(move |cancellation| async move {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {},
            _ = async {
                while let Some(mut event) = events.recv().await {
                    let receipt = event.take_receipt();
                    let (identity, event) = event.into_parts();
                    let context = sessions_module::trace::enabled().then(|| serde_json::json!({
                        "identity": sessions_module::trace::identity_shape(&identity),
                        "generation": event.binding.generation(), "sourceEpoch": event.binding.source_epoch(),
                        "nativeCursor": event.cursor, "runHash": event.run_id.as_deref().map(sessions_module::trace::fingerprint),
                    }));
                    // Stopping this wait does not retract a command already enqueued in the owner.
                    let outcome = sessions.ingest_ingress_event(SessionIngressEvent::new(identity, event)).await;
                    if sessions_module::trace::enabled() {
                        use sessions_module::trace;
                        let summary = match &outcome {
                            Ok(SessionIngestOutcome::Applied(delta)) => serde_json::json!({
                                "outcome": "applied", "identity": trace::identity_shape(&delta.identity),
                                "epoch": delta.epoch, "seq": delta.seq, "cursor": delta.cursor,
                            }),
                            Ok(SessionIngestOutcome::Consumed { cursor }) => serde_json::json!({ "outcome": "consumed", "nativeCursor": cursor }),
                            Ok(SessionIngestOutcome::Duplicate { cursor }) => serde_json::json!({ "outcome": "duplicate", "nativeCursor": cursor }),
                            Ok(SessionIngestOutcome::Stale { cursor, received }) => serde_json::json!({ "outcome": "stale", "nativeCursor": cursor, "receivedNativeCursor": received }),
                            Ok(SessionIngestOutcome::Gap { expected, received }) => serde_json::json!({ "outcome": "gap", "expectedNativeCursor": expected, "receivedNativeCursor": received }),
                            Ok(SessionIngestOutcome::Rejected { .. }) => serde_json::json!({ "outcome": "rejected" }),
                            Ok(SessionIngestOutcome::RuntimeNotFound) => serde_json::json!({ "outcome": "runtime_not_found" }),
                            Ok(SessionIngestOutcome::RuntimeNoSessionSupport) => serde_json::json!({ "outcome": "runtime_no_session_support" }),
                            Err(()) => serde_json::json!({ "outcome": "owner_unavailable" }),
                        };
                        trace::log_unscoped("host.ingress.outcome", serde_json::json!({
                            "ingressHash": trace::fingerprint(effect_id), "event": context,
                            "receiptPresent": receipt.is_some(), "result": summary,
                        }));
                    }
                    if let Some(receipt) = receipt {
                        let accepted = matches!(
                            &outcome,
                            Ok(SessionIngestOutcome::Applied(_) | SessionIngestOutcome::Consumed { .. })
                        );
                        let delivered = receipt.send(accepted).is_ok();
                        if sessions_module::trace::enabled() {
                            sessions_module::trace::log_unscoped("host.ingress.receipt", serde_json::json!({
                                "ingressHash": sessions_module::trace::fingerprint(effect_id), "event": context,
                                "accepted": accepted, "delivered": delivered,
                            }));
                        }
                    }
                    if outcome.is_err() {
                        break;
                    }
                }
            } => {},
        }
    });
    scope.register_event_subscription(effect_id, move || async move {
        let _ = task.cancel_and_join().await;
    });
}
