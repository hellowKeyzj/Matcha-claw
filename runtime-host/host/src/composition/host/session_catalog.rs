use std::time::Duration;

use foundation::process::supervision::SupervisorPhase;
use matcha_agent::{
    client::{Client, Error},
    peer::MatchaPeerLifecycleHandle,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub(super) async fn observe(
    client: Client,
    changed: watch::Sender<()>,
    cancellation: CancellationToken,
    lifecycle: MatchaPeerLifecycleHandle,
) -> Result<(), Error> {
    let mut states = lifecycle.subscribe();
    let mut reconnect_delay = Duration::from_secs(1);
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
            reconnect_delay = Duration::from_secs(1);
            continue;
        }
        let process = snapshot.process();
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = states.changed() => {
                if result.is_err() { return Ok(()); }
                continue;
            }
            result = client.subscribe_session_catalog() => result,
        };
        let error = match result {
            Ok(mut subscription) => {
                reconnect_delay = Duration::from_secs(1);
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
                            Ok(()) => { changed.send_replace(()); }
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
        if error.code().is_some()
            || matches!(
                error.kind(),
                "protocol" | "unsupported_protocol" | "client_shutdown"
            )
        {
            return Err(error);
        }
        platform::trace::runtime_trace(
            "matcha.session.catalog.reconnecting",
            || serde_json::json!({"delivery": format!("{:?}", error.delivery())}),
        );
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = states.changed() => {
                if result.is_err() { return Ok(()); }
                reconnect_delay = Duration::from_secs(1);
            },
            _ = tokio::time::sleep(reconnect_delay) => {
                reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(30));
            },
        }
    }
}
