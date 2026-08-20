use std::{
    fs,
    future::Future,
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
};

use super::*;
use crate::{
    BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy, ChannelOperationalDesired,
    ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
    DesiredDefinition, EnvironmentProjectionPort, ExtensionReference, PolicyReference,
    ProviderReference, SecurityPreset, ToolchainReference,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> std::path::PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("matcha-environment-applied-consumer-{name}-{id}"))
}

fn definition(revision: u64) -> DesiredDefinition {
    DesiredDefinition::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(revision).unwrap(),
        ProviderReference::try_new("provider:anthropic").unwrap(),
        DesiredConfiguration::try_new(
            vec![ConnectorReference::try_new("connector:slack").unwrap()],
            vec![ExtensionReference::try_new("extension:browser").unwrap()],
            vec![ChannelReference::try_new("channel:discord").unwrap()],
            vec![CredentialReference::try_new("credential:v1:reference-only").unwrap()],
            vec![PolicyReference::try_new("policy:balanced").unwrap()],
            vec![ToolchainReference::try_new("toolchain:bun").unwrap()],
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

fn verified(desired: &DesiredDefinition) -> crate::AppliedProjection {
    crate::AppliedProjection::from_verified_readback(
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

fn incomplete(desired: &DesiredDefinition) -> crate::AppliedProjection {
    crate::AppliedProjection::from_verified_readback(
        desired.environment_id().clone(),
        desired.revision(),
        desired.provider().clone(),
        Vec::new(),
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

enum ProjectionMode {
    Verified,
    Incomplete,
    Foreign,
    Fault(EnvironmentProjectionFault),
}

struct ProjectionPort {
    mode: ProjectionMode,
    calls: Arc<AtomicUsize>,
}

struct RevisionAdvancingProjectionPort {
    store_path: std::path::PathBuf,
    next_desired: DesiredDefinition,
    calls: Arc<AtomicUsize>,
}

impl ProjectionPort {
    fn verified(calls: Arc<AtomicUsize>) -> Self {
        Self {
            mode: ProjectionMode::Verified,
            calls,
        }
    }

    fn incomplete(calls: Arc<AtomicUsize>) -> Self {
        Self {
            mode: ProjectionMode::Incomplete,
            calls,
        }
    }

    fn foreign(calls: Arc<AtomicUsize>) -> Self {
        Self {
            mode: ProjectionMode::Foreign,
            calls,
        }
    }

    fn fault(calls: Arc<AtomicUsize>, fault: EnvironmentProjectionFault) -> Self {
        Self {
            mode: ProjectionMode::Fault(fault),
            calls,
        }
    }
}

impl EnvironmentProjectionPort for RevisionAdvancingProjectionPort {
    fn apply<'a>(
        &'a self,
        desired: &'a DesiredDefinition,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<crate::AppliedProjection, EnvironmentProjectionFault>>
                + Send
                + 'a,
        >,
    > {
        self.calls.fetch_add(1, Ordering::Relaxed);
        EnvironmentStore::open(&self.store_path)
            .unwrap()
            .persist_desired(self.next_desired.clone())
            .unwrap();
        Box::pin(std::future::ready(Ok(verified(desired))))
    }
}

impl EnvironmentProjectionPort for ProjectionPort {
    fn apply<'a>(
        &'a self,
        desired: &'a DesiredDefinition,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<crate::AppliedProjection, EnvironmentProjectionFault>>
                + Send
                + 'a,
        >,
    > {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let result = match &self.mode {
            ProjectionMode::Verified => Ok(verified(desired)),
            ProjectionMode::Incomplete => Ok(incomplete(desired)),
            ProjectionMode::Foreign => Ok(crate::AppliedProjection::from_verified_readback(
                EnvironmentId::try_new("environment:foreign").unwrap(),
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
            )),
            ProjectionMode::Fault(fault) => Err(*fault),
        };
        Box::pin(std::future::ready(result))
    }
}

#[test]
fn verified_projection_records_applied_evidence_but_requires_observations() {
    let root = path("success");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    drop(store);
    let mut consumer =
        EnvironmentAppliedConsumer::open(ProjectionPort::verified(calls.clone()), &store_path)
            .unwrap();

    let receipt =
        block_on(consumer.apply_revision(&environment_id, desired.revision(), &scope)).unwrap();

    assert_eq!(receipt.environment_id(), "environment:primary");
    assert_eq!(receipt.revision(), desired.revision());
    assert_eq!(
        receipt.reconciliation().state(),
        crate::EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        receipt.reconciliation().actions(),
        &[crate::EnvironmentReconciliationAction::ObserveConnectors {
            scope: scope.clone()
        }]
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert!(
        reopened
            .environment(&environment_id)
            .unwrap()
            .has_current_applied_evidence()
    );
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn tombstone_rejects_applied_projection_without_invoking_the_runtime() {
    let root = path("tombstone");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    store
        .persist_delete(&environment_id, desired.revision())
        .unwrap();
    drop(store);
    let mut consumer =
        EnvironmentAppliedConsumer::open(ProjectionPort::verified(calls.clone()), &store_path)
            .unwrap();

    assert_eq!(
        block_on(consumer.apply_revision(&environment_id, desired.revision(), &scope)),
        Err(EnvironmentAppliedFailure::UnknownEnvironment)
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn projection_fault_does_not_commit_applied_evidence() {
    let root = path("fault");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    drop(store);
    let mut consumer = EnvironmentAppliedConsumer::open(
        ProjectionPort::fault(calls.clone(), EnvironmentProjectionFault::OutcomeUnknown),
        &store_path,
    )
    .unwrap();

    assert_eq!(
        block_on(consumer.apply_revision(&environment_id, desired.revision(), &scope)),
        Err(EnvironmentAppliedFailure::Projection(
            EnvironmentProjectionFault::OutcomeUnknown
        ))
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert!(
        reopened
            .environment(&environment_id)
            .unwrap()
            .applied()
            .is_none()
    );
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn stale_revision_prevents_projection_before_effects_start() {
    let root = path("revision-conflict");
    let store_path = root.join("environment.log");
    let desired = definition(2);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(definition(1)).unwrap();
    store.persist_desired(desired).unwrap();
    drop(store);
    let mut consumer =
        EnvironmentAppliedConsumer::open(ProjectionPort::verified(calls.clone()), &store_path)
            .unwrap();

    assert_eq!(
        block_on(consumer.apply_revision(
            &environment_id,
            EnvironmentRevision::try_new(1).unwrap(),
            &scope,
        )),
        Err(EnvironmentAppliedFailure::RevisionConflict)
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert!(
        reopened
            .environment(&environment_id)
            .unwrap()
            .applied()
            .is_none()
    );
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn foreign_projection_readback_is_rejected_before_durable_commit() {
    let root = path("foreign-readback");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    drop(store);
    let mut consumer =
        EnvironmentAppliedConsumer::open(ProjectionPort::foreign(calls.clone()), &store_path)
            .unwrap();

    assert_eq!(
        block_on(consumer.apply_revision(&environment_id, desired.revision(), &scope)),
        Err(EnvironmentAppliedFailure::ProjectionBindingMismatch)
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert!(
        reopened
            .environment(&environment_id)
            .unwrap()
            .applied()
            .is_none()
    );
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn desired_revision_advance_during_projection_rejects_stale_readback() {
    let root = path("projection-race");
    let store_path = root.join("environment.log");
    let current = definition(1);
    let advanced = definition(2);
    let environment_id = current.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(current.clone()).unwrap();
    drop(store);
    let mut consumer = EnvironmentAppliedConsumer::open(
        RevisionAdvancingProjectionPort {
            store_path: store_path.clone(),
            next_desired: advanced.clone(),
            calls: calls.clone(),
        },
        &store_path,
    )
    .unwrap();

    assert_eq!(
        block_on(consumer.apply_revision(&environment_id, current.revision(), &scope)),
        Err(EnvironmentAppliedFailure::RevisionConflict)
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    let facts = reopened.environment(&environment_id).unwrap();
    assert_eq!(facts.desired_revision(), advanced.revision());
    assert!(facts.applied().is_none());
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn incomplete_readback_is_not_recorded_as_applied_evidence() {
    let root = path("incomplete");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    drop(store);
    let mut consumer =
        EnvironmentAppliedConsumer::open(ProjectionPort::incomplete(calls.clone()), &store_path)
            .unwrap();

    assert_eq!(
        block_on(consumer.apply_revision(&environment_id, desired.revision(), &scope)),
        Err(EnvironmentAppliedFailure::Store(StoreFault::ApplyEvidence(
            ApplyEvidenceFault::IncompleteVerification
        )))
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert!(
        reopened
            .environment(&environment_id)
            .unwrap()
            .applied()
            .is_none()
    );
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn repeated_projection_revalidates_readback_through_the_durable_fence() {
    let root = path("reproject");
    let store_path = root.join("environment.log");
    let desired = definition(1);
    let environment_id = desired.environment_id().clone();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut store = EnvironmentStore::open(&store_path).unwrap();
    store.persist_desired(desired.clone()).unwrap();
    store.record_applied(verified(&desired)).unwrap();
    drop(store);
    let mut consumer =
        EnvironmentAppliedConsumer::open(ProjectionPort::verified(calls.clone()), &store_path)
            .unwrap();

    let receipt =
        block_on(consumer.apply_revision(&environment_id, desired.revision(), &scope)).unwrap();

    assert_eq!(receipt.revision(), desired.revision());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert!(
        reopened
            .environment(&environment_id)
            .unwrap()
            .has_current_applied_evidence()
    );
    drop(reopened);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn post_projection_commit_unknown_and_revision_mismatch_remain_non_generic_failures() {
    assert_eq!(
        EnvironmentAppliedFailure::after_projection(StoreFault::CommitOutcomeUnknown(
            io::ErrorKind::Other,
        )),
        EnvironmentAppliedFailure::RetryUnsafeAfterProjection
    );
    assert_eq!(
        EnvironmentAppliedFailure::after_projection(StoreFault::ApplyEvidence(
            ApplyEvidenceFault::RevisionMismatch {
                desired: EnvironmentRevision::try_new(2).unwrap(),
                received: EnvironmentRevision::try_new(1).unwrap(),
            },
        )),
        EnvironmentAppliedFailure::RevisionConflict
    );
}
