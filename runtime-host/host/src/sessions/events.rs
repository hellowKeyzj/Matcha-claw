use tokio::sync::broadcast;

use super::state::SessionDelta;

#[derive(Clone)]
pub(crate) struct SessionDeltaSource {
    sender: broadcast::Sender<SessionDelta>,
}

impl SessionDeltaSource {
    pub(crate) fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub(crate) fn publish(&self, delta: SessionDelta) -> bool {
        let _ = self.sender.send(delta);
        true
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<SessionDelta> {
        self.sender.subscribe()
    }
}
