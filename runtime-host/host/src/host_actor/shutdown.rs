use tokio::sync::mpsc;

use crate::{Host, HostPhase};

use super::{ActorExit, ShutdownAttempt, ShutdownReply};

pub(super) async fn requested(
    host: &mut Host,
    reply: ShutdownReply,
    shutdown: &mut mpsc::Receiver<ShutdownReply>,
) -> ActorExit {
    if let Some(exit) = attempt(host, reply).await {
        return exit;
    }

    while let Some(reply) = shutdown.recv().await {
        if let Some(exit) = attempt(host, reply).await {
            return exit;
        }
    }

    immediate(host).await
}

pub(super) async fn immediate(host: &mut Host) -> ActorExit {
    host.shutdown().await.map(|_| ())
}

async fn attempt(host: &mut Host, reply: ShutdownReply) -> Option<ActorExit> {
    let result = host.shutdown().await;
    let terminal = host.admission_state().phase() == HostPhase::ShutDown;
    let _ = reply.send(ShutdownAttempt {
        result: result.clone(),
        terminal,
    });
    terminal.then(|| result.map(|_| ()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn shutdown_boundary_does_not_hold_product_terms() {
        let source = include_str!("shutdown.rs");
        let production = source
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .expect("shutdown tests must stay after production code");

        for removed in [
            concat!("Session", "Command"),
            concat!("Team", "Run"),
            concat!("Fleet", "Command"),
            concat!("Security", "Command"),
            concat!("Provider", "Command"),
            concat!("Runtime", "Job"),
        ] {
            assert!(
                !production.contains(removed),
                "shutdown boundary retains product surface: {removed}"
            );
        }
    }
}
