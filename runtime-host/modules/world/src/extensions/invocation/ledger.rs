use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard},
};

use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use world_protocol::ids::{AcquisitionId, PluginGenerationId, ResourceToken};

use super::resource::*;

type Custody = Arc<AsyncMutex<Box<dyn HostResource>>>;

#[derive(Clone)]
pub(crate) struct ResourceLedger {
    inner: Arc<Ledger>,
}

struct Ledger {
    generation: PluginGenerationId,
    state: Mutex<State>,
    changed: Notify,
    inspection_changed: Notify,
    drain: AsyncMutex<()>,
    cleanup: CleanupControl,
}

struct State {
    admission: Admission,
    cancel_requested: bool,
    entries: BTreeMap<ResourceToken, Entry>,
}

struct Entry {
    identity: Arc<()>,
    snapshot: ResourceSnapshot,
    cancellation: CancellationToken,
    custody: Option<Custody>,
    finished: bool,
}

/// A unique registration capability. Dropping it does not establish release.
#[must_use = "complete or retain the registration after actual resource cleanup"]
pub(crate) struct Registration {
    ledger: ResourceLedger,
    token: ResourceToken,
    identity: Arc<()>,
    cancellation: CancellationToken,
}

/// Registered before async creation; even an abandoned ticket remains visible.
#[must_use = "complete acquisition or fail it only after creation has actually ended"]
pub(crate) struct AcquisitionTicket {
    registration: Registration,
}

pub(crate) struct Acquired {
    pub registration: Registration,
    pub must_release: bool,
}

impl ResourceLedger {
    pub fn new(generation: PluginGenerationId) -> Self {
        Self {
            inner: Arc::new(Ledger {
                generation,
                state: Mutex::new(State {
                    admission: Admission::Open,
                    cancel_requested: false,
                    entries: BTreeMap::new(),
                }),
                changed: Notify::new(),
                inspection_changed: Notify::new(),
                drain: AsyncMutex::new(()),
                cleanup: CleanupControl::new(),
            }),
        }
    }

    pub fn cleanup_control(&self) -> CleanupControl {
        self.inner.cleanup.clone()
    }
    pub fn same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// The resource must not exist yet. Use an acquisition ticket for async setup.
    pub fn register(&self, spec: ResourceSpec) -> Result<Registration, AdmissionFailure> {
        self.insert(spec, None)
    }

    pub fn begin_acquisition(
        &self,
        acquisition: AcquisitionId,
        spec: ResourceSpec,
    ) -> Result<AcquisitionTicket, AdmissionFailure> {
        self.insert(spec, Some(acquisition))
            .map(|registration| AcquisitionTicket { registration })
    }

    fn insert(
        &self,
        spec: ResourceSpec,
        acquisition: Option<AcquisitionId>,
    ) -> Result<Registration, AdmissionFailure> {
        let mut state = self.state();
        if state.admission != Admission::Open {
            return Err(AdmissionFailure::Closed);
        }
        if state.entries.contains_key(&spec.token) {
            return Err(AdmissionFailure::DuplicateToken(spec.token));
        }
        if let Some(acquisition) = &acquisition {
            if state
                .entries
                .values()
                .any(|entry| entry.snapshot.acquisition.as_ref() == Some(acquisition))
            {
                return Err(AdmissionFailure::DuplicateAcquisition(acquisition.clone()));
            }
        }
        if let Some(parent) = &spec.parent {
            if !state.entries.get(parent).is_some_and(|entry| {
                !entry.finished && matches!(entry.snapshot.state, ResourceState::Active)
            }) {
                return Err(AdmissionFailure::ParentUnavailable(parent.clone()));
            }
        }
        let identity = Arc::new(());
        let cancellation = CancellationToken::new();
        let registration = Registration {
            ledger: self.clone(),
            token: spec.token.clone(),
            identity: identity.clone(),
            cancellation: cancellation.clone(),
        };
        let resource_state = if acquisition.is_some() {
            ResourceState::Acquiring
        } else {
            ResourceState::Active
        };
        state.entries.insert(
            spec.token.clone(),
            Entry {
                identity,
                snapshot: ResourceSnapshot {
                    spec,
                    acquisition,
                    state: resource_state,
                    failure: None,
                },
                cancellation,
                custody: None,
                finished: false,
            },
        );
        Ok(registration)
    }

    /// Called inside bindings' one publication/admission gate. Locks each exact
    /// generation in stable order, preflights the whole set, then registers all.
    pub fn register_batch(
        resources: &[(ResourceLedger, ResourceSpec)],
    ) -> Result<Vec<Registration>, AdmissionFailure> {
        let mut ledgers = BTreeMap::<PluginGenerationId, &ResourceLedger>::new();
        for (ledger, _) in resources {
            if let Some(existing) = ledgers.insert(ledger.inner.generation.clone(), ledger) {
                if !Arc::ptr_eq(&existing.inner, &ledger.inner) {
                    return Err(AdmissionFailure::GenerationConflict(
                        ledger.inner.generation.clone(),
                    ));
                }
            }
        }
        let mut states = ledgers
            .iter()
            .map(|(generation, ledger)| (generation, ledger.state()))
            .collect::<BTreeMap<_, _>>();
        let mut tokens = std::collections::BTreeSet::new();
        for (ledger, spec) in resources {
            let state = &states[&ledger.inner.generation];
            if state.admission != Admission::Open {
                return Err(AdmissionFailure::Closed);
            }
            if state.entries.contains_key(&spec.token)
                || !tokens.insert((&ledger.inner.generation, &spec.token))
            {
                return Err(AdmissionFailure::DuplicateToken(spec.token.clone()));
            }
            if let Some(parent) = &spec.parent {
                if !state.entries.get(parent).is_some_and(|entry| {
                    !entry.finished && entry.snapshot.state == ResourceState::Active
                }) {
                    return Err(AdmissionFailure::ParentUnavailable(parent.clone()));
                }
            }
        }
        let registrations = resources
            .iter()
            .map(|(ledger, spec)| {
                let state = states
                    .get_mut(&ledger.inner.generation)
                    .expect("preflight locked generation");
                let identity = Arc::new(());
                let cancellation = CancellationToken::new();
                state.entries.insert(
                    spec.token.clone(),
                    Entry {
                        identity: identity.clone(),
                        snapshot: ResourceSnapshot {
                            spec: spec.clone(),
                            acquisition: None,
                            state: ResourceState::Active,
                            failure: None,
                        },
                        cancellation: cancellation.clone(),
                        custody: None,
                        finished: false,
                    },
                );
                Registration {
                    ledger: ledger.clone(),
                    token: spec.token.clone(),
                    identity,
                    cancellation,
                }
            })
            .collect();
        Ok(registrations)
    }

    /// Call under the shared graph admission/publication gate for graph changes.
    /// Closing the entrance does not cancel resources before business checkpoint.
    pub fn close_admission(&self) -> LedgerSnapshot {
        let mut state = self.state();
        if state.admission == Admission::Open {
            state.admission = Admission::Closing;
        }
        self.inner.changed.notify_one();
        self.snapshot_locked(&state)
    }

    /// Call inside the same publication gate as graph admission and Closing.
    /// This only tightens cleanup policy; no path can re-enable guest interaction.
    pub fn quarantine(&self) -> LedgerSnapshot {
        let mut state = self.state();
        if state.admission == Admission::Open {
            state.admission = Admission::Closing;
        }
        self.inner.cleanup.quarantine();
        self.inner.changed.notify_one();
        self.snapshot_locked(&state)
    }

    /// Request only. Tokens, Arc counts and task cancellation are not drain proof.
    pub fn request_cancel(&self) -> Result<(), AdmissionFailure> {
        let cancellations = {
            let mut state = self.state();
            if state.admission == Admission::Open {
                return Err(AdmissionFailure::StillOpen);
            }
            state.cancel_requested = true;
            state
                .entries
                .values_mut()
                .map(|entry| {
                    if entry.snapshot.state == ResourceState::Active {
                        entry.snapshot.state = ResourceState::CancelRequested;
                    }
                    entry.cancellation.clone()
                })
                .collect::<Vec<_>>()
        };
        for cancellation in cancellations {
            cancellation.cancel();
        }
        self.inner.changed.notify_one();
        Ok(())
    }

    pub fn snapshot(&self) -> LedgerSnapshot {
        self.snapshot_locked(&self.state())
    }

    pub fn inspect_process(
        &self,
        invocation: &world_protocol::ids::InvocationId,
    ) -> Option<crate::extensions::process::ProcessInspection> {
        let custody = {
            let state = self.state();
            let mut calls = state.entries.values().filter(|entry| {
                entry.snapshot.spec.kind == ResourceKind::ChildCall
                    && entry.snapshot.spec.invocation.as_ref() == Some(invocation)
            });
            let custody = calls.next()?.custody.clone()?;
            if calls.next().is_some() {
                return None;
            }
            custody
        };
        let resource = custody.try_lock().ok()?;
        resource.inspect_process(self)
    }

    pub(crate) fn process_inspections(
        &self,
        invocation: &world_protocol::ids::InvocationId,
    ) -> Option<Vec<crate::extensions::process::ProcessInspection>> {
        let custody = {
            let state = self.state();
            state.entries.values().filter(|entry| {
                entry.snapshot.spec.kind == ResourceKind::ChildCall
                    && entry.snapshot.spec.invocation.as_ref() == Some(invocation)
            }).map(|entry| entry.custody.clone()).collect::<Option<Vec<_>>>()?
        };
        custody.into_iter().map(|custody| {
            custody.try_lock().ok()?.inspect_process(self)
        }).collect()
    }

    pub fn resource(&self, token: &ResourceToken) -> Option<ResourceSnapshot> {
        self.state()
            .entries
            .get(token)
            .map(|entry| entry.snapshot.clone())
    }

    pub fn inspection_changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.inner.inspection_changed.notified()
    }

    async fn close_resource(
        &self,
        token: &ResourceToken,
        identity: &Arc<()>,
        deadline: Instant,
    ) -> Result<(), ResourceFailure> {
        let custody = {
            let mut state = self.state();
            if state
                .entries
                .values()
                .any(|entry| entry.snapshot.spec.parent.as_ref() == Some(token))
            {
                return Err(ResourceFailure::new(
                    ResourceStage::Cleanup,
                    "children_remaining",
                    "child resources have not completed",
                ));
            }
            let Some(entry) = matching(&mut state, token, identity) else {
                return Ok(());
            };
            let Some(custody) = entry.custody.clone() else {
                return Err(ResourceFailure::new(
                    ResourceStage::Cleanup,
                    "external_completion_required",
                    "resource requires its owner's explicit completion",
                ));
            };
            entry.snapshot.state = ResourceState::Releasing;
            custody
        };
        let cleanup = async {
            let mut resource = custody.lock().await;
            // Serialize cleanup and completion so a second closer never polls a
            // task/receipt that the first closer has already consumed.
            if matching(&mut self.state(), token, identity).is_none() {
                return Ok(());
            }
            let result = resource
                .close_checked(deadline, self.inner.cleanup.clone())
                .await;
            match &result {
                Ok(()) => self.finish(token, identity),
                Err(failure) => self.retain(token, identity, failure.clone()),
            }
            result
        };
        match tokio::time::timeout_at(deadline, cleanup).await {
            Ok(result) => result,
            Err(_) => {
                let failure = ResourceFailure::new(
                    ResourceStage::Cleanup,
                    "cleanup_deadline",
                    "resource cleanup has not completed before the deadline",
                );
                self.retain(token, identity, failure.clone());
                Err(failure)
            }
        }
    }

    /// The caller owns this wait. Timing out never drops ledger-owned resources.
    /// A failed cleanup stays retained; the next call may retry it.
    pub async fn drain_until(&self, deadline: Instant) -> Result<DrainOutcome, AdmissionFailure> {
        let Ok(_drain) = tokio::time::timeout_at(deadline, self.inner.drain.lock()).await else {
            return Ok(DrainOutcome::Retained(self.snapshot()));
        };
        if self.state().admission == Admission::Open {
            return Err(AdmissionFailure::StillOpen);
        }
        loop {
            let changed = self.inner.changed.notified();
            let work = {
                let mut state = self.state();
                if state.entries.is_empty() {
                    state.admission = Admission::Closed;
                    return Ok(DrainOutcome::Drained);
                }
                state
                    .entries
                    .iter()
                    .filter_map(|(token, entry)| {
                        if entry.finished
                            || entry.snapshot.acquisition.is_some()
                            || entry.custody.is_none()
                        {
                            return None;
                        }
                        Some((token.clone(), entry.identity.clone()))
                    })
                    .collect::<Vec<_>>()
            };
            let work = work
                .into_iter()
                .filter(|(token, _)| {
                    !self
                        .state()
                        .entries
                        .values()
                        .any(|entry| entry.snapshot.spec.parent.as_ref() == Some(token))
                })
                .collect::<Vec<_>>();
            let results = futures_util::future::join_all(
                work.iter()
                    .map(|(token, identity)| self.close_resource(token, identity, deadline)),
            )
            .await;
            let cleanup_failed = results.iter().any(Result::is_err);
            let snapshot = self.snapshot();
            if snapshot.resources.is_empty() {
                continue;
            }
            if cleanup_failed || Instant::now() >= deadline {
                return Ok(DrainOutcome::Retained(snapshot));
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return Ok(DrainOutcome::Retained(self.snapshot()));
            }
        }
    }

    fn finish(&self, token: &ResourceToken, identity: &Arc<()>) {
        let mut state = self.state();
        if let Some(entry) = matching(&mut state, token, identity) {
            entry.finished = true;
            entry.snapshot.failure = None;
            entry.snapshot.state = ResourceState::WaitingForChildren;
        }
        loop {
            let complete = state.entries.iter().find_map(|(token, entry)| {
                (entry.finished
                    && !state
                        .entries
                        .values()
                        .any(|child| child.snapshot.spec.parent.as_ref() == Some(token)))
                .then(|| token.clone())
            });
            let Some(complete) = complete else { break };
            state.entries.remove(&complete);
        }
        drop(state);
        self.inner.changed.notify_one();
        self.inner.inspection_changed.notify_waiters();
    }

    fn retain(&self, token: &ResourceToken, identity: &Arc<()>, failure: ResourceFailure) {
        if let Some(entry) = matching(&mut self.state(), token, identity) {
            entry.snapshot.state = ResourceState::Retained;
            entry.snapshot.failure = Some(failure);
        }
        self.inner.changed.notify_one();
        self.inner.inspection_changed.notify_waiters();
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .expect("world resource ledger mutex poisoned")
    }

    fn snapshot_locked(&self, state: &State) -> LedgerSnapshot {
        LedgerSnapshot {
            generation: self.inner.generation.clone(),
            admission: state.admission,
            dependency_retained: state
                .entries
                .values()
                .filter(|entry| entry.snapshot.spec.kind == ResourceKind::Dependency)
                .count(),
            invocation_inflight: state
                .entries
                .values()
                .filter(|entry| entry.snapshot.spec.kind == ResourceKind::Invocation)
                .count(),
            acquisitions: state
                .entries
                .values()
                .filter(|entry| entry.snapshot.acquisition.is_some())
                .count(),
            resources: state
                .entries
                .values()
                .map(|entry| entry.snapshot.clone())
                .collect(),
        }
    }
}

impl AcquisitionTicket {
    pub fn cancellation(&self) -> &CancellationToken {
        &self.registration.cancellation
    }

    /// Ownership is installed even if Closing won while creation was in flight.
    /// The caller must not discard a successfully created resource on late arrival.
    pub fn complete(self, resource: Box<dyn HostResource>) -> Acquired {
        let registration = self.registration;
        let mut state = registration.ledger.state();
        let must_release = state.admission != Admission::Open || state.cancel_requested;
        let entry = matching(&mut state, &registration.token, &registration.identity)
            .expect("acquisition ticket retains its ledger entry");
        entry.snapshot.acquisition = None;
        entry.custody = Some(Arc::new(AsyncMutex::new(resource)));
        entry.snapshot.state = if must_release {
            ResourceState::CancelRequested
        } else {
            ResourceState::Active
        };
        drop(state);
        if must_release {
            registration.cancellation.cancel();
        }
        registration.ledger.inner.changed.notify_one();
        Acquired {
            registration,
            must_release,
        }
    }

    /// Creation has actually ended without acquiring a resource, not just timed out.
    pub fn fail(self) {
        self.registration.finish();
    }
}

impl Registration {
    pub fn token(&self) -> &ResourceToken {
        &self.token
    }
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    /// Only for externally completed resources. Ledger-owned custody is closed by drain.
    pub fn finish(self) {
        let managed = self
            .ledger
            .state()
            .entries
            .get(&self.token)
            .is_some_and(|entry| entry.custody.is_some());
        assert!(!managed, "ledger-owned resource requires checked cleanup");
        self.ledger.finish(&self.token, &self.identity);
    }

    pub fn retain(&self, failure: ResourceFailure) {
        self.ledger.retain(&self.token, &self.identity, failure);
    }

    pub async fn close_checked(&mut self, deadline: Instant) -> Result<(), ResourceFailure> {
        self.ledger
            .close_resource(&self.token, &self.identity, deadline)
            .await
    }
}

fn matching<'a>(
    state: &'a mut State,
    token: &ResourceToken,
    identity: &Arc<()>,
) -> Option<&'a mut Entry> {
    state
        .entries
        .get_mut(token)
        .filter(|entry| Arc::ptr_eq(&entry.identity, identity))
}
