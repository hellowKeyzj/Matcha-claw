use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use foundation::execution::OwnedTask;
use tokio_util::sync::CancellationToken;

use crate::application::terminal::TerminalContext;
use crate::terminal::{Generation, SessionId};
use crate::{FleetTargetConfig, TargetEndpointBinding, TargetId, TargetSnapshot};

#[derive(Clone)]
pub(crate) struct TerminalTarget {
    pub(crate) snapshot: TargetSnapshot,
    pub(crate) config: FleetTargetConfig,
    pub(crate) binding: TargetEndpointBinding,
}

impl TerminalTarget {
    pub(crate) fn matches(&self, facts: &crate::store::FleetFacts) -> bool {
        facts.target_snapshot(self.snapshot.id()).as_ref() == Some(&self.snapshot)
            && facts.target_configuration(self.snapshot.id()) == Some(&self.config)
            && facts.target_binding(self.snapshot.id()) == Some(&self.binding)
    }
}

struct Execution {
    context: TerminalContext,
    target: TerminalTarget,
    cancellation: CancellationToken,
    redeemed: bool,
    opening: Option<CancellationToken>,
    task: Option<OwnedTask<()>>,
    stopped: CancellationToken,
    cleanup_started: bool,
}

#[derive(Clone, Default)]
pub(crate) struct TerminalExecutions(Arc<Mutex<BTreeMap<(SessionId, Generation), Execution>>>);

pub(crate) struct TerminalOpening {
    pub(crate) target: TerminalTarget,
    pub(crate) cancellation: CancellationToken,
    done: Option<tokio_util::sync::DropGuard>,
    session: SessionId,
    generation: Generation,
    executions: TerminalExecutions,
}

impl TerminalExecutions {
    pub(crate) fn insert(&self, context: TerminalContext, target: TerminalTarget) {
        self.0.lock().expect("terminal executions lock").insert(
            (context.session.clone(), context.generation),
            Execution {
                context,
                target,
                cancellation: CancellationToken::new(),
                redeemed: false,
                opening: None,
                task: None,
                stopped: CancellationToken::new(),
                cleanup_started: false,
            },
        );
    }

    pub(crate) fn context(
        &self,
        session: &SessionId,
        generation: Generation,
    ) -> Option<TerminalContext> {
        let entries = self.0.lock().expect("terminal executions lock");
        let entry = entries.get(&(session.clone(), generation))?;
        (!entry.cancellation.is_cancelled()).then(|| entry.context.clone())
    }

    pub(crate) fn cancellation(&self, context: &TerminalContext) -> Option<CancellationToken> {
        let entries = self.0.lock().expect("terminal executions lock");
        let entry = entries.get(&(context.session.clone(), context.generation))?;
        (entry.context == *context && !entry.cancellation.is_cancelled())
            .then(|| entry.cancellation.child_token())
    }

    pub(crate) fn redeem(&self, summary: &crate::terminal::SessionSummary) {
        if let Some(entry) = self
            .0
            .lock()
            .expect("terminal executions lock")
            .get_mut(&(summary.id().clone(), summary.generation()))
        {
            entry.redeemed = true;
        }
    }

    pub(crate) fn begin_open(&self, context: &TerminalContext) -> Option<TerminalOpening> {
        let mut entries = self.0.lock().expect("terminal executions lock");
        let entry = entries.get_mut(&(context.session.clone(), context.generation))?;
        if entry.context != *context
            || !entry.redeemed
            || entry.cancellation.is_cancelled()
            || entry.opening.is_some()
        {
            return None;
        }
        let done = CancellationToken::new();
        entry.opening = Some(done.clone());
        Some(TerminalOpening {
            target: entry.target.clone(),
            cancellation: entry.cancellation.clone(),
            done: Some(done.drop_guard()),
            session: context.session.clone(),
            generation: context.generation,
            executions: self.clone(),
        })
    }

    pub(crate) fn reconnect(&self, summary: &crate::terminal::SessionSummary) {
        let mut entries = self.0.lock().expect("terminal executions lock");
        let previous = entries
            .iter()
            .rev()
            .find(|((session, _), _)| session == summary.id())
            .map(|(_, entry)| (entry.context.clone(), entry.target.clone()));
        let mut revoked = Vec::new();
        if let Some((mut context, target)) = previous {
            for ((session, generation), entry) in entries.iter() {
                if session == summary.id() {
                    entry.cancellation.cancel();
                    revoked.push(*generation);
                }
            }
            context.generation = summary.generation();
            entries.insert(
                (context.session.clone(), context.generation),
                Execution {
                    context,
                    target,
                    cancellation: CancellationToken::new(),
                    redeemed: false,
                    opening: None,
                    task: None,
                    stopped: CancellationToken::new(),
                    cleanup_started: false,
                },
            );
        }
        drop(entries);
        for generation in revoked {
            self.revoke(summary.id(), generation);
        }
    }

    pub(crate) fn invalidate_target(&self, target: &TargetId, current: Option<&TargetSnapshot>) {
        let sessions: Vec<_> = self
            .0
            .lock()
            .expect("terminal executions lock")
            .iter()
            .filter(|(_, entry)| {
                entry.target.snapshot.id() == target && Some(&entry.target.snapshot) != current
            })
            .map(|(key, _)| key.clone())
            .collect();
        for (session, generation) in sessions {
            self.revoke(&session, generation);
        }
    }

    pub(crate) async fn shutdown(&self) {
        let sessions: Vec<_> = self
            .0
            .lock()
            .expect("terminal executions lock")
            .keys()
            .cloned()
            .collect();
        for (session, generation) in &sessions {
            self.revoke(session, *generation);
        }
        for (session, generation) in sessions {
            self.stop(&session, generation).await;
        }
    }

    pub(crate) fn revoke(&self, session: &SessionId, generation: Generation) {
        if let Some(entry) = self
            .0
            .lock()
            .expect("terminal executions lock")
            .get(&(session.clone(), generation))
        {
            entry.cancellation.cancel();
        }
        let executions = self.clone();
        let session = session.clone();
        tokio::spawn(async move {
            executions.stop(&session, generation).await;
        });
    }

    pub(crate) async fn stop_previous(&self, session: &SessionId, generation: Generation) {
        let previous: Vec<_> = self
            .0
            .lock()
            .expect("terminal executions lock")
            .keys()
            .filter(|(id, current)| id == session && *current < generation)
            .map(|(_, current)| *current)
            .collect();
        for previous in previous {
            self.stop(session, previous).await;
        }
    }

    pub(crate) async fn stop(&self, session: &SessionId, generation: Generation) {
        let key = (session.clone(), generation);
        let (opening, stopped) = {
            let entries = self.0.lock().expect("terminal executions lock");
            let Some(entry) = entries.get(&key) else {
                return;
            };
            entry.cancellation.cancel();
            (entry.opening.clone(), entry.stopped.clone())
        };
        if let Some(opening) = opening {
            opening.cancelled().await;
        }
        let task = {
            let mut entries = self.0.lock().expect("terminal executions lock");
            match entries.get_mut(&key) {
                Some(entry) if !entry.cleanup_started => {
                    entry.cleanup_started = true;
                    let task = entry.task.take();
                    if task.is_none() {
                        entry.stopped.cancel();
                    }
                    task
                }
                _ => None,
            }
        };
        if let Some(mut task) = task {
            // Continue joining even if the REST/WS caller disconnects during cleanup.
            let done = stopped.clone();
            tokio::spawn(async move {
                let _ = task.cancel_and_join().await;
                done.cancel();
            });
        }
        stopped.cancelled().await;
        self.0
            .lock()
            .expect("terminal executions lock")
            .remove(&key);
    }
}

impl TerminalOpening {
    pub(crate) fn attach(&mut self, task: OwnedTask<()>) {
        let mut entries = self.executions.0.lock().expect("terminal executions lock");
        if let Some(entry) = entries.get_mut(&(self.session.clone(), self.generation)) {
            entry.task = Some(task);
        }
        // Publish the task before waking close, which then owns its join.
        self.done.take();
    }
}
