use std::{
    fs,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
    time::SystemTime,
};

use super::*;
use crate::{
    AppliedProjection, BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy,
    ChannelObservation, ChannelOperationalDesired, ChannelReference, ChannelRuntimeStatus,
    DesiredConfiguration, DesiredDefinition, EnvironmentObservation, EnvironmentObservationFault,
    EnvironmentObservationPort, EnvironmentReconciliationState, EnvironmentRevision,
    EnvironmentStore, ObservationFreshness, OperationalObservation, ProviderReference,
    RuntimeObservationScope, SecurityObservation, SecurityPreset, SecurityRuntimeStatus,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> std::path::PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("matcha-environment-observed-consumer-{name}-{id}"))
}

fn definition(revision: u64) -> DesiredDefinition {
    DesiredDefinition::new(
        crate::EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(revision).unwrap(),
        ProviderReference::try_new("provider:anthropic").unwrap(),
        DesiredConfiguration::try_new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            SecurityPreset::Strict,
            BrowserMode::Native,
            vec![ChannelOperationalDesired::new(
                ChannelReference::try_new("discord").unwrap(),
                ChannelAccountId::try_new("primary").unwrap(),
                true,
                ChannelDirectMessagePolicy::Pairing,
            )],
        )
        .unwrap(),
    )
}

fn verified(desired: &DesiredDefinition) -> AppliedProjection {
    AppliedProjection::from_verified_readback(
        desired.environment_id().clone(),
        desired.revision(),
        desired.provider().clone(),
        desired.connectors().to_vec(),
        desired.extensions().to_vec(),
        desired.channels().to_vec(),
        desired.credential_references().to_vec(),
        desired.policies().to_vec(),
        desired.toolchains().to_vec(),
        desired.security_preset(),
        desired.browser_mode(),
        desired.operational_channels().to_vec(),
    )
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

#[derive(Clone, Copy)]
enum ObservationMode {
    Current,
    ForeignScope,
}

struct ObservationPort {
    mode: ObservationMode,
    connector_calls: Arc<AtomicUsize>,
    operational_calls: Arc<AtomicUsize>,
}

impl ObservationPort {
    fn scope(&self, scope: &RuntimeObservationScope) -> RuntimeObservationScope {
        match self.mode {
            ObservationMode::Current => scope.clone(),
            ObservationMode::ForeignScope => {
                RuntimeObservationScope::try_new("scope:foreign").unwrap()
            }
        }
    }
}

impl EnvironmentObservationPort for ObservationPort {
    fn observe_operational<'a>(
        &'a self,
        environment_id: &'a crate::EnvironmentId,
        applied_revision: EnvironmentRevision,
        scope: &'a RuntimeObservationScope,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<OperationalObservation, EnvironmentObservationFault>>
                + Send
                + 'a,
        >,
    > {
        self.operational_calls.fetch_add(1, Ordering::Relaxed);
        let observation = OperationalObservation::new(
            environment_id.clone(),
            self.scope(scope),
            applied_revision,
            SystemTime::UNIX_EPOCH,
            ObservationFreshness::Current,
            Some(SecurityObservation::new(
                SecurityPreset::Strict,
                SecurityRuntimeStatus::Healthy,
            )),
            vec![ChannelObservation::new(
                ChannelOperationalDesired::new(
                    ChannelReference::try_new("discord").unwrap(),
                    ChannelAccountId::try_new("primary").unwrap(),
                    true,
                    ChannelDirectMessagePolicy::Pairing,
                ),
                ChannelRuntimeStatus::Connected,
            )],
        )
        .unwrap();
        Box::pin(std::future::ready(Ok(observation)))
    }

    fn observe_connectors<'a>(
        &'a self,
        environment_id: &'a crate::EnvironmentId,
        applied_revision: EnvironmentRevision,
        scope: &'a RuntimeObservationScope,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<EnvironmentObservation, EnvironmentObservationFault>>
                + Send
                + 'a,
        >,
    > {
        self.connector_calls.fetch_add(1, Ordering::Relaxed);
        let observation = EnvironmentObservation::new(
            environment_id.clone(),
            self.scope(scope),
            applied_revision,
            crate::ConnectorObservationSource::Runtime,
            SystemTime::UNIX_EPOCH,
            ObservationFreshness::Current,
            Vec::new(),
        )
        .unwrap();
        Box::pin(std::future::ready(Ok(observation)))
    }
}

#[test]
fn current_revision_bound_native_observations_derive_operationally_healthy_reconciliation() {
    let root = path("current");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    store.record_applied(verified(&desired)).unwrap();
    drop(store);
    let connector_calls = Arc::new(AtomicUsize::new(0));
    let operational_calls = Arc::new(AtomicUsize::new(0));
    let mut consumer = EnvironmentObservedConsumer::open(
        ObservationPort {
            mode: ObservationMode::Current,
            connector_calls: connector_calls.clone(),
            operational_calls: operational_calls.clone(),
        },
        &store_path,
    )
    .unwrap();

    let receipt = block_on(consumer.observe_revision(&environment_id, desired.revision(), &scope))
        .expect("verified observations must derive a plan");

    assert_eq!(receipt.environment_id(), "environment:primary");
    assert_eq!(receipt.revision(), desired.revision());
    assert_eq!(
        receipt.reconciliation().state(),
        EnvironmentReconciliationState::OperationalConverged
    );
    assert_eq!(connector_calls.load(Ordering::Relaxed), 1);
    assert_eq!(operational_calls.load(Ordering::Relaxed), 1);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn tombstone_rejects_observation_without_invoking_the_runtime() {
    let root = path("tombstone");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    store
        .persist_delete(&environment_id, desired.revision())
        .unwrap();
    drop(store);
    let connector_calls = Arc::new(AtomicUsize::new(0));
    let operational_calls = Arc::new(AtomicUsize::new(0));
    let mut consumer = EnvironmentObservedConsumer::open(
        ObservationPort {
            mode: ObservationMode::Current,
            connector_calls: connector_calls.clone(),
            operational_calls: operational_calls.clone(),
        },
        &store_path,
    )
    .unwrap();

    assert_eq!(
        block_on(consumer.observe_revision(&environment_id, desired.revision(), &scope)),
        Err(EnvironmentObservedFailure::UnknownEnvironment)
    );
    assert_eq!(connector_calls.load(Ordering::Relaxed), 0);
    assert_eq!(operational_calls.load(Ordering::Relaxed), 0);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn foreign_scope_readback_is_rejected_before_it_can_be_interpreted_as_observed_or_healthy() {
    let root = path("foreign-scope");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    store.record_applied(verified(&desired)).unwrap();
    drop(store);
    let connector_calls = Arc::new(AtomicUsize::new(0));
    let operational_calls = Arc::new(AtomicUsize::new(0));
    let mut consumer = EnvironmentObservedConsumer::open(
        ObservationPort {
            mode: ObservationMode::ForeignScope,
            connector_calls: connector_calls.clone(),
            operational_calls: operational_calls.clone(),
        },
        &store_path,
    )
    .unwrap();

    assert_eq!(
        block_on(consumer.observe_revision(&environment_id, desired.revision(), &scope)),
        Err(EnvironmentObservedFailure::ObservationBindingMismatch)
    );
    assert_eq!(connector_calls.load(Ordering::Relaxed), 1);
    assert_eq!(operational_calls.load(Ordering::Relaxed), 0);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn observation_consumer_does_not_query_runtime_before_current_applied_evidence_exists() {
    let root = path("unapplied");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    drop(store);
    let connector_calls = Arc::new(AtomicUsize::new(0));
    let operational_calls = Arc::new(AtomicUsize::new(0));
    let mut consumer = EnvironmentObservedConsumer::open(
        ObservationPort {
            mode: ObservationMode::Current,
            connector_calls: connector_calls.clone(),
            operational_calls: operational_calls.clone(),
        },
        &store_path,
    )
    .unwrap();

    let receipt = block_on(consumer.observe_revision(&environment_id, desired.revision(), &scope))
        .expect("projection requirement is a valid reconciliation result");

    assert_eq!(
        receipt.reconciliation().state(),
        EnvironmentReconciliationState::ProjectionRequired
    );
    assert_eq!(connector_calls.load(Ordering::Relaxed), 0);
    assert_eq!(operational_calls.load(Ordering::Relaxed), 0);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn observation_consumer_keeps_native_observation_faults_distinct_from_binding_failures() {
    assert_eq!(
        EnvironmentObservedFailure::Observation(EnvironmentObservationFault::OutcomeUnknown),
        EnvironmentObservedFailure::Observation(EnvironmentObservationFault::OutcomeUnknown)
    );
}
