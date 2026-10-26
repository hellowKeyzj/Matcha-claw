use std::sync::Arc;

use world_protocol::{
    ids::{CommitId, InstallId, Revision, WorldRef},
    operation::OperationAccepted,
};

use super::LiveExtensions;
use crate::{extensions::package::CommittedDisable, store::CommittedWorldMutation};

/// An owned selection for checkpointing accepted work, never a drain proof.
#[derive(Clone)]
pub(crate) struct AcceptedClosing {
    origin: Arc<()>,
    selection: Selection,
}

#[derive(Clone)]
enum Selection {
    World(CommittedWorldMutation),
    Install {
        world: WorldRef,
        install: InstallId,
        commit: CommitId,
        revision: Revision,
        operation: OperationAccepted,
    },
}

impl AcceptedClosing {
    pub(super) fn world_selection(origin: Arc<()>, intent: &CommittedWorldMutation) -> Self {
        Self {
            origin,
            selection: Selection::World(intent.clone()),
        }
    }

    pub(super) fn install_selection(origin: Arc<()>, intent: &CommittedDisable) -> Self {
        Self {
            origin,
            selection: Selection::Install {
                world: intent.world().clone(),
                install: intent.install().clone(),
                commit: intent.commit_id().clone(),
                revision: intent.revision(),
                operation: intent.operation().clone(),
            },
        }
    }

    pub fn world(&self) -> &WorldRef {
        match &self.selection {
            Selection::World(intent) => intent.world(),
            Selection::Install { world, .. } => world,
        }
    }

    pub fn commit_id(&self) -> &CommitId {
        match &self.selection {
            Selection::World(intent) => intent.commit_id(),
            Selection::Install { commit, .. } => commit,
        }
    }

    pub fn operation(&self) -> &OperationAccepted {
        match &self.selection {
            Selection::World(intent) => intent.operation(),
            Selection::Install { operation, .. } => operation,
        }
    }

    pub fn world_intent(&self) -> Option<&CommittedWorldMutation> {
        match &self.selection {
            Selection::World(intent) => Some(intent),
            Selection::Install { .. } => None,
        }
    }

    pub fn install(&self) -> Option<&InstallId> {
        match &self.selection {
            Selection::World(_) => None,
            Selection::Install { install, .. } => Some(install),
        }
    }

    pub fn revision(&self) -> Option<Revision> {
        match &self.selection {
            Selection::World(_) => None,
            Selection::Install { revision, .. } => Some(*revision),
        }
    }

    pub fn final_commit_id(&self) -> Option<&CommitId> {
        match &self.selection {
            Selection::World(intent) => Some(intent.final_commit_id()),
            Selection::Install { .. } => None,
        }
    }
}

impl LiveExtensions {
    pub fn validate_accepted_closing(&self, proof: &AcceptedClosing) -> bool {
        if !Arc::ptr_eq(&self.identity, &proof.origin) {
            return false;
        }
        self.gate.synchronized(|_| {
            let registry = self
                .registry
                .lock()
                .expect("world extension registry poisoned");
            match &proof.selection {
                Selection::World(intent) => {
                    registry.closing_worlds.contains(intent.world())
                        && !registry.stopped_worlds.contains(intent.world())
                        && registry
                            .world_mutations
                            .get(intent.world())
                            .is_some_and(|fence| fence.accepts_checkpoint(intent))
                }
                Selection::Install {
                    world,
                    install,
                    commit,
                    revision,
                    ..
                } => registry
                    .install_fences
                    .get(&(world.clone(), install.clone()))
                    .is_some_and(|fence| {
                        fence.closing && &fence.commit == commit && &fence.revision == revision
                    }),
            }
        })
    }
}
