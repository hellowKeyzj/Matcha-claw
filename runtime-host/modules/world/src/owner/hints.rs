use std::{collections::{BTreeMap, VecDeque}, sync::{Arc, Mutex}};

use tokio::sync::{broadcast, watch};
use world_protocol::{events::WorldHint, ids::WorldRef};

use super::Error;

pub(super) struct Hints {
    sender: broadcast::Sender<WorldHint>,
    closed: watch::Sender<bool>,
    cursors: Mutex<BTreeMap<WorldRef, crate::store::HintCursor>>,
}

impl Hints {
    pub(super) fn new() -> Arc<Self> {
        let (sender, _) = broadcast::channel(256);
        let (closed, _) = watch::channel(false);
        Arc::new(Self { sender, closed, cursors: Mutex::new(BTreeMap::new()) })
    }

    pub(super) fn close(&self) { self.closed.send_replace(true); }

    pub(super) fn cursor(&self, world: &WorldRef) -> Option<crate::store::HintCursor> {
        self.cursors.lock().expect("world hint cursors poisoned").get(world).copied()
    }

    pub(super) fn publish(&self, world: WorldRef, page: crate::store::HintPage) {
        self.cursors.lock().expect("world hint cursors poisoned").insert(world, page.cursor);
        if let Some(hint) = page.resync { let _ = self.sender.send(hint); }
        for event in page.events { let _ = self.sender.send(event.hint); }
    }

    fn resync(&self) -> VecDeque<WorldHint> {
        self.cursors.lock().expect("world hint cursors poisoned").iter().map(|(world, cursor)| WorldHint::ResyncRequired {
            world: world.clone(), incarnation: cursor.incarnation,
        }).collect()
    }

    pub(super) fn subscribe(self: &Arc<Self>) -> WorldHintSubscription {
        let receiver = self.sender.subscribe();
        WorldHintSubscription { hints: self.clone(), receiver, closed: self.closed.subscribe(), pending: self.resync() }
    }
}

/// Bounded invalidations only. A lag invalidates every affected known world, not only the last frame.
pub struct WorldHintSubscription {
    hints: Arc<Hints>,
    receiver: broadcast::Receiver<WorldHint>,
    closed: watch::Receiver<bool>,
    pending: VecDeque<WorldHint>,
}

impl WorldHintSubscription {
    pub async fn recv(&mut self) -> Result<WorldHint, Error> {
        loop {
            if *self.closed.borrow() { return Err(super::runtime::closed()); }
            if let Some(hint) = self.pending.pop_front() { return Ok(hint); }
            tokio::select! {
                biased;
                _ = self.closed.changed() => return Err(super::runtime::closed()),
                result = self.receiver.recv() => match result {
                    Ok(hint) => return Ok(hint),
                    Err(broadcast::error::RecvError::Lagged(_)) => self.pending = self.hints.resync(),
                    Err(cause) => return Err(Error::internal(world_protocol::failure::FailureStage::Read).caused(cause)),
                }
            }
        }
    }
}
