use foundation::execution::OwnedTask;
use sessions_module::{SessionHandle, command::SessionIngressEvent};
use tokio::sync::mpsc;

pub(in crate::composition::host) fn forward(
    scope: &mut foundation::lifecycle::ModuleScope,
    sessions: SessionHandle,
    effect_id: &'static str,
    mut events: mpsc::Receiver<SessionIngressEvent>,
) {
    let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {},
            _ = async {
                while let Some(event) = events.recv().await {
                    // Stopping this wait does not retract a command already enqueued in the owner.
                    if sessions.ingest_ingress_event(event).await.is_err() {
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
