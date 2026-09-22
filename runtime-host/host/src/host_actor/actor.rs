use tokio::sync::mpsc;

use crate::{
    Host,
    composition::{HostEvent, HostEvents},
};

use super::{ActorExit, HostStatePublisher, ShutdownReply};

enum Next {
    Shutdown(ShutdownReply),
    Event(Option<HostEvent>),
}

pub(super) async fn run(
    mut host: Host,
    mut events: HostEvents,
    mut shutdown: mpsc::Receiver<ShutdownReply>,
    output: mpsc::Sender<HostEvent>,
    state: HostStatePublisher,
) -> ActorExit {
    let mut events_open = true;
    state.publish(host.state());
    loop {
        let next = next(Some(&mut events), &mut events_open, &mut shutdown).await;
        match next {
            Next::Shutdown(reply) => {
                return super::shutdown::requested(&mut host, reply, &mut shutdown).await;
            }
            Next::Event(Some(event)) => {
                if matches!(
                    event,
                    HostEvent::OpenClawRuntime | HostEvent::MatchaLifecycle(_)
                ) {
                    state.publish(host.state());
                }
                tokio::select! {
                    biased;
                    // A consumed event may be discarded only when leaving for shutdown.
                    Some(reply) = shutdown.recv() => {
                        return super::shutdown::requested(&mut host, reply, &mut shutdown).await;
                    }
                    result = output.send(event) => {
                        if result.is_err() {
                            return super::shutdown::immediate(&mut host).await;
                        }
                    }
                }
            }
            Next::Event(None) => events_open = false,
        }
    }
}

async fn next(
    mut events: Option<&mut HostEvents>,
    events_open: &mut bool,
    shutdown: &mut mpsc::Receiver<ShutdownReply>,
) -> Next {
    tokio::select! {
        biased;
        Some(reply) = shutdown.recv() => Next::Shutdown(reply),
        event = wait_for_events(&mut events), if *events_open => Next::Event(event),
    }
}

async fn wait_for_events(events: &mut Option<&mut HostEvents>) -> Option<HostEvent> {
    match events.as_deref_mut() {
        Some(events) => events.next().await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn root_actor_keeps_product_state_out() {
        let source = include_str!("actor.rs");
        let production = source
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .expect("actor tests must stay after production code");

        for removed in [
            concat!("ingest", "_event"),
            concat!("publish", "_session", "_delta"),
            concat!("Session", "Event"),
            concat!("Session", "Change"),
            concat!("Session", "Identity"),
            concat!("Session", "Provider"),
            concat!("Canonical", "Ingress", "Result"),
            concat!("Renderer", "Event"),
            concat!("Recovery", "Reason"),
            concat!("Team", "Run", "Command"),
            concat!("Fleet", "Command"),
            concat!("Security", "Command"),
            concat!("Provider", "Command"),
        ] {
            assert!(
                !production.contains(removed),
                "root actor retains product state surface: {removed}"
            );
        }
    }

    #[test]
    fn root_actor_updates_cached_state_for_peer_lifecycle_events() {
        let source = include_str!("actor.rs");
        let production = source
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .expect("actor tests must stay after production code");

        assert!(production.contains("HostEvent::OpenClawRuntime"));
        assert!(production.contains("HostEvent::MatchaLifecycle(_)"));
        assert_eq!(production.matches("state.publish(host.state())").count(), 2);
        assert!(production.contains("result = output.send(event)"));
    }

    #[test]
    fn root_actor_delegates_shutdown_boundary() {
        let source = include_str!("actor.rs");
        let production = source
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .expect("actor tests must stay after production code");

        assert!(production.contains("super::shutdown::requested"));
        assert!(production.contains("super::shutdown::immediate"));
        assert!(!production.contains("host.shutdown().await"));
    }
}
