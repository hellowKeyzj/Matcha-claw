use foundation::process::supervision::SupervisorPhase;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::{
    client::{Client, Error},
    peer::MatchaPeerLifecycleHandle,
};

/// The existing Cron module scope owns this observer; it never submits or cancels a Run.
pub async fn observe_receipts(
    client: Client,
    changed: watch::Sender<()>,
    cancellation: CancellationToken,
    lifecycle: MatchaPeerLifecycleHandle,
) -> Result<(), Error> {
    let mut states = lifecycle.subscribe();
    let mut process = None;
    let mut cursor = 0;
    let mut resynced = false;
    let mut reconnecting = false;
    loop {
        let snapshot = states.borrow_and_update().clone();
        if snapshot.phase() == SupervisorPhase::ShutDown {
            return Ok(());
        }
        if snapshot.phase() != SupervisorPhase::Running {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Ok(()),
                result = states.changed() => if result.is_err() { return Ok(()); },
            }
            reconnecting = false;
            continue;
        }
        // No durable home identity is exposed. A real process change conservatively resyncs,
        // rather than claiming that an old cursor belongs to the replacement database.
        if process != snapshot.process() {
            process = snapshot.process();
            cursor = 0;
            resynced = false;
            reconnecting = false;
            changed.send_replace(());
        }
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = states.changed() => {
                if result.is_err() { return Ok(()); }
                continue;
            }
            result = client.subscribe_schedule_receipts(cursor) => result,
        };
        let error = match result {
            Ok(mut subscription) => {
                reconnecting = false;
                changed.send_replace(());
                let error = loop {
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => {
                            let _ = subscription.close().await;
                            return Ok(());
                        }
                        result = states.changed() => {
                            if result.is_err() {
                                let _ = subscription.close().await;
                                return Ok(());
                            }
                            let current = states.borrow().clone();
                            if current.phase() != SupervisorPhase::Running || current.process() != process {
                                break None;
                            }
                        }
                        result = subscription.recv() => match result {
                            Ok(change) => {
                                changed.send_replace(());
                                cursor = change.seq;
                            }
                            Err(error) => break Some(error),
                        }
                    }
                };
                let _ = subscription.close().await;
                let Some(error) = error else {
                    continue;
                };
                error
            }
            Err(error) => error,
        };
        if matches!(
            error.kind(),
            "schedule_cursor_ahead" | "schedule_sequence_gap" | "schedules_sequence_gap"
        ) {
            changed.send_replace(());
            if cursor == 0 || resynced {
                return Err(error);
            }
            cursor = 0;
            resynced = true;
            reconnecting = false;
            continue;
        }
        if error.code().is_some()
            || matches!(
                error.kind(),
                "protocol" | "unsupported_protocol" | "client_shutdown"
            )
        {
            return Err(error);
        }
        // Reopen a broken observation once; if the listener is still down, wait for the
        // existing supervisor readiness transition instead of polling schedules or a timer.
        if !reconnecting {
            reconnecting = true;
            continue;
        }
        platform::trace::runtime_trace(
            "matcha.cron.observer.waiting_for_runtime",
            || serde_json::json!({"cursor":cursor,"delivery":format!("{:?}",error.delivery())}),
        );
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = states.changed() => if result.is_err() { return Ok(()); },
        }
        reconnecting = false;
    }
}
