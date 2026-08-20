use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

use crate::{
    audit::{
        FleetAuditEntry, FleetAuditEvent, FleetAuditEventInput, FleetAuditValue, REDACTED_VALUE,
    },
    command::{
        CommandId, CommandIntent, CommandKind, CommandState, CommandTarget, IdempotencyKey,
        StartOutcome, SubmitOutcome, TransitionOutcome,
    },
    connection::{ConnectionId, ConnectionKind, ConnectionRecord},
    environment::{
        CleanupPolicy, EnvironmentId, EnvironmentKind, EnvironmentRecord, ManagedResourceId,
        ManagedResourceKind, ManagedResourceProvider, ManagedResourceRecord, Ownership,
    },
    lease::{Capacity, LeaseDuration, LeaseId, LeaseOwner, LeaseOwnerKind},
    outbox::{
        BeginDeliveryOutcome, DispatchId, DispatchIntent, DispatchPhase, InsertOutcome,
        ReplayOutcome,
    },
    reachability::{
        ExternalRelayOrigin, LoopbackIngressListener, ReachabilityStatus, RelayAuthority,
        RelayAuthorityId, RelayBinding, RelayBindingId, RelayKind, RelayScheme,
        RuntimeAgentIngressReachabilityFacts,
    },
    secret_ref::FleetSecretRef,
    topology::{
        AgentObservation, CredentialHash, EndpointHealth, EndpointObservation, EnrollmentRecord,
        EnrollmentUse, FleetTopologyFacts, IngressCredentialIssue, IngressCredentialRecord,
        IngressCredentialRevocation, NodeHealth, NodeId, NodeObservation, ObservationFreshness,
        ObservationMetadata, ObservationSource, RuntimeId, RuntimeKind, RuntimeObservation,
        RuntimeState,
    },
};
use platform::{
    capability::{CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability},
    endpoint::{EndpointId, NativeAgentId},
};

use super::{
    FleetStore, StoreFault, codec,
    durable::{AgentIngressIdentity, IngressAuthentication, IngressCredential, IngressEnrollment},
};

const SECRET_CANARY: &str = "fleet-store-secret-canary";
const INGRESS_RAW_INPUT_CANARY: &str = "fleet-ingress-raw-input-canary";

fn associated_topology(
    connection_id: &str,
    environment_id: &str,
    resource_id: &str,
) -> FleetTopologyFacts {
    let observed_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let metadata = ObservationMetadata::new(
        ObservationSource::Discovery,
        observed_at,
        ObservationFreshness::Current,
    );
    let node_id = NodeId::try_new("node-associated").unwrap();
    let runtime_id = RuntimeId::try_new("runtime-associated").unwrap();
    let connection_id = ConnectionId::try_new(connection_id).unwrap();
    let environment_id = EnvironmentId::try_new(environment_id).unwrap();
    let resource_id = ManagedResourceId::try_new(resource_id).unwrap();
    let association = crate::topology::TopologyAssociation::new(
        Some(connection_id),
        Some(environment_id),
        Some(resource_id),
    );
    FleetTopologyFacts::restore(
        vec![NodeObservation::with_association(
            node_id.clone(),
            association.clone(),
            NodeHealth::Online {
                last_seen_at: observed_at,
            },
            metadata,
        )],
        vec![AgentObservation::with_association(
            NativeAgentId::try_new("agent-associated").unwrap(),
            node_id.clone(),
            association.clone(),
            metadata,
        )],
        vec![RuntimeObservation::with_association(
            runtime_id.clone(),
            node_id.clone(),
            Some(NativeAgentId::try_new("agent-associated").unwrap()),
            association.clone(),
            RuntimeKind::OpenClaw,
            RuntimeState::Running {
                started_at: observed_at,
            },
            metadata,
        )],
        vec![EndpointObservation::with_association(
            EndpointId::try_new("endpoint-associated").unwrap(),
            node_id,
            runtime_id,
            association,
            EndpointHealth::Ready,
            Vec::new(),
            Vec::new(),
            metadata,
        )],
    )
    .unwrap()
}

#[test]
fn runtime_agent_reachability_facts_survive_durable_reopen() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let observed_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let expected = RuntimeAgentIngressReachabilityFacts::try_new(
        NativeAgentId::try_new("agent-reachability").unwrap(),
        RelayBinding::new(
            RelayBindingId::try_new("binding-1").unwrap(),
            RelayAuthority::try_new(
                RelayAuthorityId::try_new("authority-1").unwrap(),
                ExternalRelayOrigin::try_new(RelayScheme::Https, "relay.example.test", 443)
                    .unwrap(),
                RelayKind::ReverseProxy,
            ),
            LoopbackIngressListener::try_new(34123).unwrap(),
        ),
        ReachabilityStatus::Reachable {
            verified_at: observed_at,
        },
        observed_at,
        observed_at + Duration::from_secs(3_600),
    )
    .unwrap();

    store
        .transact(|facts| {
            *facts = super::FleetFacts::restore(super::FleetFactsRestoreInput {
                commands: Vec::new(),
                dispatches: Vec::new(),
                secret_references: Vec::new(),
                audit_entries: Vec::new(),
                topology: topology(),
                enrollments: Vec::new(),
                ingress_credentials: Vec::new(),
                targets: Vec::new(),
                connections: Vec::new(),
                environments: Vec::new(),
                managed_resources: Vec::new(),
                effects: Vec::new(),
                runtime_agents: Vec::new(),
                runtime_agent_reachability: vec![expected.clone()],
                leases: Vec::new(),
                bindings: Vec::new(),
            })?;
            Ok(())
        })
        .unwrap();
    drop(store);

    let reopened = FleetStore::open(&path).unwrap();
    let persisted = reopened
        .facts()
        .runtime_agent_reachability_facts()
        .collect::<Vec<_>>();
    assert_eq!(persisted, vec![&expected]);
    let persisted = persisted[0];
    assert_eq!(persisted.agent_id().as_str(), "agent-reachability");
    assert_eq!(persisted.binding().id().as_str(), "binding-1");
    assert_eq!(persisted.binding().authority().id().as_str(), "authority-1");
    assert_eq!(
        persisted.binding().authority().origin().origin(),
        "https://relay.example.test:443"
    );
    assert_eq!(
        persisted.status(),
        ReachabilityStatus::Reachable {
            verified_at: observed_at
        }
    );
    assert_eq!(persisted.observed_at(), observed_at);
    assert_eq!(
        persisted.expires_at(),
        observed_at + Duration::from_secs(3_600)
    );
}

#[test]
fn associated_topology_facts_survive_durable_reopen() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(20);
    let connection = ConnectionRecord::new(
        ConnectionId::try_new("connection-associated").unwrap(),
        ConnectionKind::SshHost,
        "Associated SSH".into(),
        now,
    );
    let environment = EnvironmentRecord::new(
        EnvironmentId::try_new("environment-associated").unwrap(),
        ConnectionId::try_new("connection-associated").unwrap(),
        "Associated environment".into(),
        EnvironmentKind::SshWorkdir,
        now,
    );
    let resource = ManagedResourceRecord::new(
        ManagedResourceId::try_new("resource-associated").unwrap(),
        ConnectionId::try_new("connection-associated").unwrap(),
        EnvironmentId::try_new("environment-associated").unwrap(),
        ManagedResourceProvider::Ssh,
        ManagedResourceKind::SshAgentInstallation,
        "remote-agent-associated".into(),
        Ownership::MatchaManaged,
        CleanupPolicy::UninstallAgentOnly,
        now,
    );
    let topology = associated_topology(
        "connection-associated",
        "environment-associated",
        "resource-associated",
    );
    store
        .transact(|facts| {
            facts.upsert_connection(connection, now)?;
            facts.register_environment(environment, now)?;
            facts.register_managed_resource(resource)?;
            facts.upsert_node(topology.nodes()[0].clone(), now)?;
            facts.upsert_agent(topology.agents()[0].clone(), now)?;
            facts.upsert_runtime(topology.runtimes()[0].clone(), now)?;
            facts.upsert_endpoint(topology.endpoints()[0].clone(), now)?;
            Ok(())
        })
        .unwrap();
    drop(store);

    let reopened = FleetStore::open(&path).unwrap();
    for association in reopened
        .facts()
        .topology()
        .nodes()
        .iter()
        .map(|item| item.association())
        .chain(
            reopened
                .facts()
                .topology()
                .agents()
                .iter()
                .map(|item| item.association()),
        )
        .chain(
            reopened
                .facts()
                .topology()
                .runtimes()
                .iter()
                .map(|item| item.association()),
        )
        .chain(
            reopened
                .facts()
                .topology()
                .endpoints()
                .iter()
                .map(|item| item.association()),
        )
    {
        assert_eq!(
            association.connection_id().unwrap().as_str(),
            "connection-associated"
        );
        assert_eq!(
            association.environment_id().unwrap().as_str(),
            "environment-associated"
        );
        assert_eq!(
            association.managed_resource_id().unwrap().as_str(),
            "resource-associated"
        );
    }
}

#[test]
fn topology_association_rejects_unknown_durable_records() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let node = associated_topology(
        "connection-missing",
        "environment-missing",
        "resource-missing",
    )
    .nodes()[0]
        .clone();
    let error = store
        .transact(|facts| {
            facts.upsert_node(node, SystemTime::UNIX_EPOCH + Duration::from_secs(20))?;
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(
        error,
        StoreFault::Facts(crate::store::FleetFactsError::InvalidTopologyAssociation)
    ));
}

#[test]
fn topology_association_rejects_cross_resource_mismatch() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(20);
    let connection = ConnectionRecord::new(
        ConnectionId::try_new("connection-a").unwrap(),
        ConnectionKind::SshHost,
        "Connection A".into(),
        now,
    );
    let connection_b = ConnectionRecord::new(
        ConnectionId::try_new("connection-b").unwrap(),
        ConnectionKind::SshHost,
        "Connection B".into(),
        now,
    );
    let environment = EnvironmentRecord::new(
        EnvironmentId::try_new("environment-a").unwrap(),
        ConnectionId::try_new("connection-a").unwrap(),
        "Environment A".into(),
        EnvironmentKind::SshWorkdir,
        now,
    );
    let resource = ManagedResourceRecord::new(
        ManagedResourceId::try_new("resource-a").unwrap(),
        ConnectionId::try_new("connection-a").unwrap(),
        EnvironmentId::try_new("environment-a").unwrap(),
        ManagedResourceProvider::Ssh,
        ManagedResourceKind::SshAgentInstallation,
        "agent-a".into(),
        Ownership::MatchaManaged,
        CleanupPolicy::UninstallAgentOnly,
        now,
    );
    let error = store
        .transact(|facts| {
            facts.upsert_connection(connection, now)?;
            facts.upsert_connection(connection_b, now)?;
            facts.register_environment(environment, now)?;
            facts.register_managed_resource(resource)?;
            let node = associated_topology("connection-a", "environment-a", "resource-a").nodes()
                [0]
            .clone();
            let mismatched = NodeObservation::with_association(
                node.id().clone(),
                crate::topology::TopologyAssociation::new(
                    Some(ConnectionId::try_new("connection-b").unwrap()),
                    Some(EnvironmentId::try_new("environment-a").unwrap()),
                    Some(ManagedResourceId::try_new("resource-a").unwrap()),
                ),
                node.health(),
                node.metadata(),
            );
            facts.upsert_node(mismatched, now)?;
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(
        error,
        StoreFault::Facts(crate::store::FleetFactsError::InvalidTopologyAssociation)
    ));
}

#[test]
fn leases_survive_reopen_with_state_and_owner_intact() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let endpoint = EndpointId::try_new("endpoint-lease").unwrap();
    let lease_id = LeaseId::try_new("lease-1").unwrap();
    let owner = LeaseOwner::try_new(LeaseOwnerKind::Session, "session-1").unwrap();
    let acquired_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let mut store = FleetStore::open(&path).unwrap();
    store
        .transact(|facts| {
            assert_eq!(
                facts.leases_mut().acquire(
                    lease_id.clone(),
                    endpoint.clone(),
                    owner.clone(),
                    acquired_at,
                    LeaseDuration::try_new(Duration::from_secs(30)).unwrap(),
                    Capacity::try_new(1).unwrap(),
                ),
                crate::lease::AcquireOutcome::Acquired
            );
            Ok(())
        })
        .unwrap();
    drop(store);
    let reopened = FleetStore::open(&path).unwrap();
    let lease = reopened.facts().leases().lease(&lease_id).unwrap();
    assert_eq!(lease.endpoint(), &endpoint);
    assert_eq!(lease.owner(), &owner);
    assert_eq!(lease.acquired_at(), acquired_at);
    assert_eq!(
        lease.state(),
        crate::lease::LeaseState::Active {
            expires_at: acquired_at + Duration::from_secs(30),
        }
    );
}

#[test]
fn transaction_persists_command_dispatch_reference_and_redacted_audit_together() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let command = command();
    let command_id = command.command_id().clone();
    let dispatch_id = dispatch_id();
    let reference = FleetSecretRef::parse("remote-fleet://production/bootstrap-token").unwrap();
    let mut store = FleetStore::open(&path).unwrap();

    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().submit(command),
                SubmitOutcome::Submitted(_)
            ));
            assert_eq!(
                facts.outbox_mut().insert(DispatchIntent::new(
                    dispatch_id.clone(),
                    command_id,
                    agent_id()
                )),
                InsertOutcome::Inserted
            );
            facts.retain_secret_reference(reference);
            facts.append_audit(audit_entry())?;
            Ok(())
        })
        .unwrap();
    drop(store);

    let bytes = fs::read(&path).unwrap();
    assert!(
        !bytes
            .windows(SECRET_CANARY.len())
            .any(|window| window == SECRET_CANARY.as_bytes())
    );

    let reopened = FleetStore::open(&path).unwrap();
    let facts = reopened.facts();
    assert_eq!(facts.command_ledger().records().count(), 1);
    assert_eq!(facts.outbox().records().count(), 1);
    let dispatch = facts
        .outbox()
        .record(&dispatch_id)
        .expect("persisted dispatch must be present");
    assert_eq!(dispatch.phase(), DispatchPhase::Pending);
    assert_eq!(dispatch.intent().agent_id(), &agent_id());
    assert_eq!(
        facts
            .secret_references()
            .map(FleetSecretRef::as_str)
            .collect::<Vec<_>>(),
        ["remote-fleet://production/bootstrap-token"]
    );
    assert_eq!(facts.audit_entries().len(), 1);
    assert_eq!(
        facts.audit_entries()[0].event().message(),
        Some(REDACTED_VALUE)
    );
    assert_eq!(
        facts.audit_entries()[0]
            .event()
            .metadata()
            .get("authorization"),
        Some(&FleetAuditValue::Text(REDACTED_VALUE.to_owned()))
    );
}

#[test]
fn opening_a_nested_durable_path_creates_its_parent_directory() {
    let root = TestRoot::new();
    let path = root.0.join("nested").join("facts.log");

    let store = FleetStore::open(&path).unwrap();

    assert!(path.is_file());
    assert!(store.facts().secret_references().next().is_none());
}

#[test]
fn recovery_marks_interrupted_delivery_unknown_until_replay_is_explicitly_authorized() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let command = command();
    let command_id = command.command_id().clone();
    let dispatch_id = dispatch_id();
    let mut store = FleetStore::open(&path).unwrap();

    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().submit(command),
                SubmitOutcome::Submitted(_)
            ));
            assert_eq!(
                facts.outbox_mut().insert(DispatchIntent::new(
                    dispatch_id.clone(),
                    command_id,
                    agent_id()
                )),
                InsertOutcome::Inserted
            );
            Ok(())
        })
        .unwrap();
    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.outbox_mut().begin_delivery(&dispatch_id),
                BeginDeliveryOutcome::Begun(_)
            ));
            Ok(())
        })
        .unwrap();
    let committed_len_before_recovery = fs::metadata(&path).unwrap().len();
    drop(store);

    let reopened = FleetStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .outbox()
            .record(&dispatch_id)
            .expect("persisted dispatch must be present")
            .phase(),
        DispatchPhase::OutcomeUnknown
    );
    assert!(reopened.facts().outbox().pending().next().is_none());
    drop(reopened);

    let recovered_len = fs::metadata(&path).unwrap().len();
    assert!(recovered_len > committed_len_before_recovery);

    let mut reopened = FleetStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .outbox()
            .record(&dispatch_id)
            .expect("recovered dispatch must remain present")
            .phase(),
        DispatchPhase::OutcomeUnknown
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), recovered_len);

    reopened
        .transact(|facts| -> Result<(), StoreFault> {
            assert_eq!(
                facts.outbox_mut().authorize_replay(&dispatch_id),
                ReplayOutcome::Authorized
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        reopened
            .facts()
            .outbox()
            .record(&dispatch_id)
            .expect("authorized dispatch must remain present")
            .phase(),
        DispatchPhase::Pending
    );
}

#[test]
fn failed_mutation_does_not_commit_partial_facts() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let reference = FleetSecretRef::parse("remote-fleet://production/aborted-transaction").unwrap();

    assert_eq!(
        store.transact(|facts| -> Result<(), StoreFault> {
            facts.retain_secret_reference(reference);
            Err(StoreFault::RecoveryRequired)
        }),
        Err(StoreFault::RecoveryRequired)
    );
    drop(store);

    let reopened = FleetStore::open(&path).unwrap();
    assert!(reopened.facts().secret_references().next().is_none());
}

#[test]
fn separately_opened_writers_refresh_before_each_commit() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut first = FleetStore::open(&path).unwrap();
    let mut second = FleetStore::open(&path).unwrap();

    first
        .transact(|facts| -> Result<(), StoreFault> {
            facts.retain_secret_reference(
                FleetSecretRef::parse("remote-fleet://production/first-writer").unwrap(),
            );
            Ok(())
        })
        .unwrap();
    second
        .transact(|facts| -> Result<(), StoreFault> {
            facts.retain_secret_reference(
                FleetSecretRef::parse("remote-fleet://production/second-writer").unwrap(),
            );
            Ok(())
        })
        .unwrap();
    drop(first);
    drop(second);

    let reopened = FleetStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .secret_references()
            .map(FleetSecretRef::as_str)
            .collect::<Vec<_>>(),
        [
            "remote-fleet://production/first-writer",
            "remote-fleet://production/second-writer",
        ]
    );
}

#[test]
fn same_instance_can_acknowledge_an_in_flight_delivery() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let command = command();
    let command_id = command.command_id().clone();
    let dispatch_id = dispatch_id();
    let mut store = FleetStore::open(&path).unwrap();

    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().submit(command),
                SubmitOutcome::Submitted(_)
            ));
            assert_eq!(
                facts.outbox_mut().insert(DispatchIntent::new(
                    dispatch_id.clone(),
                    command_id,
                    agent_id()
                )),
                InsertOutcome::Inserted
            );
            Ok(())
        })
        .unwrap();
    let attempt = store
        .transact(|facts| -> Result<_, StoreFault> {
            match facts.outbox_mut().begin_delivery(&dispatch_id) {
                BeginDeliveryOutcome::Begun(attempt) => Ok(attempt),
                outcome => panic!("expected a delivery attempt, got {outcome:?}"),
            }
        })
        .unwrap();
    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts
                    .outbox_mut()
                    .acknowledge_delivery(&dispatch_id, &attempt),
                crate::outbox::AcknowledgeDeliveryOutcome::Delivered(_)
            ));
            Ok(())
        })
        .unwrap();

    assert_eq!(
        store
            .facts()
            .outbox()
            .record(&dispatch_id)
            .expect("acknowledged dispatch must remain present")
            .phase(),
        DispatchPhase::Delivered
    );
}

#[test]
fn command_attempt_and_unknown_outcome_survive_reopen_and_fence_stale_receipts() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let command = command();
    let command_id = command.command_id().clone();
    let mut store = FleetStore::open(&path).unwrap();

    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().submit(command),
                SubmitOutcome::Submitted(_)
            ));
            Ok(())
        })
        .unwrap();
    let first_attempt = store
        .transact(|facts| -> Result<_, StoreFault> {
            let ledger = facts.command_ledger_mut();
            match ledger.start(&command_id, SystemTime::UNIX_EPOCH) {
                StartOutcome::Started { attempt, .. } => Ok(attempt),
                outcome => panic!("expected a command start, got {outcome:?}"),
            }
        })
        .unwrap();
    let observed_at = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
    store
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().mark_outcome_unknown(
                    &command_id,
                    &first_attempt,
                    observed_at
                ),
                TransitionOutcome::Transitioned(_)
            ));
            Ok(())
        })
        .unwrap();
    drop(store);

    let mut reopened = FleetStore::open(&path).unwrap();
    let record = reopened
        .facts()
        .command_ledger()
        .record(&command_id)
        .expect("persisted command must be present");
    assert_eq!(
        record.state(),
        &CommandState::OutcomeUnknown { observed_at }
    );
    assert_eq!(record.attempt().map(|attempt| attempt.sequence()), Some(1));
    let replayed_at = observed_at + Duration::from_secs(1);
    let second_attempt = reopened
        .transact(|facts| -> Result<_, StoreFault> {
            let ledger = facts.command_ledger_mut();
            assert!(matches!(
                ledger.authorize_replay(&command_id, replayed_at),
                TransitionOutcome::Transitioned(_)
            ));
            match ledger.start(&command_id, replayed_at) {
                StartOutcome::Started { attempt, .. } => Ok(attempt),
                outcome => panic!("expected replayed command start, got {outcome:?}"),
            }
        })
        .unwrap();
    assert_eq!(second_attempt.sequence(), 2);

    reopened
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts
                    .command_ledger_mut()
                    .succeed(&command_id, &first_attempt, replayed_at),
                TransitionOutcome::StaleAttempt(_)
            ));
            Ok(())
        })
        .unwrap();
    drop(reopened);

    let mut reopened = FleetStore::open(&path).unwrap();
    let settled_at = replayed_at + Duration::from_secs(1);
    reopened
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts
                    .command_ledger_mut()
                    .succeed(&command_id, &second_attempt, settled_at),
                TransitionOutcome::Transitioned(_)
            ));
            Ok(())
        })
        .unwrap();
    assert_eq!(
        reopened
            .facts()
            .command_ledger()
            .record(&command_id)
            .expect("replayed command must remain present")
            .state(),
        &CommandState::Succeeded {
            completed_at: settled_at
        }
    );
}

#[test]
fn incomplete_tail_is_discarded_without_losing_the_last_committed_facts() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();

    store
        .transact(|facts| -> Result<(), StoreFault> {
            facts.retain_secret_reference(
                FleetSecretRef::parse("remote-fleet://production/recovery-reference").unwrap(),
            );
            Ok(())
        })
        .unwrap();
    drop(store);
    let committed_len = fs::metadata(&path).unwrap().len();
    let mut log = OpenOptions::new().append(true).open(&path).unwrap();
    log.write_all(&[0xA1, 1, 2, 3]).unwrap();
    log.sync_all().unwrap();
    drop(log);

    let reopened = FleetStore::open(&path).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    assert_eq!(
        reopened
            .facts()
            .secret_references()
            .map(FleetSecretRef::as_str)
            .collect::<Vec<_>>(),
        ["remote-fleet://production/recovery-reference"]
    );
}

#[test]
fn writer_lock_and_corrupt_committed_records_fail_closed() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    fs::write(&lock_path, []).unwrap();

    assert_eq!(
        store.transact(|_| Ok::<(), StoreFault>(())),
        Err(StoreFault::WriterBusy)
    );
    fs::remove_file(&lock_path).unwrap();
    store
        .transact(|facts| -> Result<(), StoreFault> {
            facts.retain_secret_reference(
                FleetSecretRef::parse("remote-fleet://production/corrupt-record").unwrap(),
            );
            Ok(())
        })
        .unwrap();
    drop(store);

    let mut content = fs::read(&path).unwrap();
    *content
        .last_mut()
        .expect("committed Fleet log has a frame payload") ^= 0xFF;
    fs::write(&path, content).unwrap();

    assert!(matches!(
        FleetStore::open(&path),
        Err(StoreFault::CorruptRecord)
    ));
}

#[test]
fn migrates_v5_log_to_v6_without_rebinding_legacy_dispatches() {
    let root = TestRoot::new();
    let path = root.0.join("v5.log");
    let command = command();
    let command_id = command.command_id().clone();
    let dispatch_id = dispatch_id();
    let mut source = FleetStore::open(&path).unwrap();
    source
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().submit(command),
                SubmitOutcome::Submitted(_)
            ));
            assert_eq!(
                facts.outbox_mut().insert(DispatchIntent::new(
                    dispatch_id.clone(),
                    command_id,
                    agent_id()
                )),
                InsertOutcome::Inserted
            );
            Ok(())
        })
        .unwrap();
    let frame = codec::encode_v5_frame(1, source.facts()).unwrap();
    drop(source);
    let mut content = Vec::from(codec::LOG_MAGIC);
    content.push(5);
    content.extend_from_slice(&0_u64.to_le_bytes());
    content.extend_from_slice(&frame);
    fs::write(&path, content).unwrap();

    let migrated = FleetStore::open(&path).unwrap();
    let dispatch = migrated.facts().outbox().record(&dispatch_id).unwrap();
    assert!(dispatch.intent().target().is_none());
    drop(migrated);

    let content = fs::read(&path).unwrap();
    assert_eq!(
        content[codec::LOG_MAGIC.len()],
        codec::CURRENT_SCHEMA_VERSION
    );
    let reopened = FleetStore::open(&path).unwrap();
    assert!(
        reopened
            .facts()
            .outbox()
            .record(&dispatch_id)
            .unwrap()
            .intent()
            .target()
            .is_none()
    );
}

#[test]
fn legacy_v5_interrupted_delivery_migrates_to_unknown_without_auto_replay() {
    let root = TestRoot::new();
    let path = root.0.join("v5-interrupted.log");
    let command = command();
    let command_id = command.command_id().clone();
    let dispatch_id = dispatch_id();
    let mut source = FleetStore::open(&path).unwrap();
    source
        .transact(|facts| -> Result<(), StoreFault> {
            assert!(matches!(
                facts.command_ledger_mut().submit(command),
                SubmitOutcome::Submitted(_)
            ));
            assert_eq!(
                facts.outbox_mut().insert(DispatchIntent::new(
                    dispatch_id.clone(),
                    command_id,
                    agent_id()
                )),
                InsertOutcome::Inserted
            );
            assert!(matches!(
                facts.outbox_mut().begin_delivery(&dispatch_id),
                BeginDeliveryOutcome::Begun(_)
            ));
            Ok(())
        })
        .unwrap();
    let frame = codec::encode_v5_frame(1, source.facts()).unwrap();
    drop(source);
    let mut content = Vec::from(codec::LOG_MAGIC);
    content.push(5);
    content.extend_from_slice(&0_u64.to_le_bytes());
    content.extend_from_slice(&frame);
    fs::write(&path, content).unwrap();

    let migrated = FleetStore::open(&path).unwrap();
    let dispatch = migrated.facts().outbox().record(&dispatch_id).unwrap();
    assert_eq!(dispatch.phase(), DispatchPhase::OutcomeUnknown);
    assert!(dispatch.intent().target().is_none());
    assert!(migrated.facts().outbox().pending().next().is_none());
}

#[test]
fn replaced_v1_and_future_schemas_fail_closed() {
    let root = TestRoot::new();
    let v1_path = root.0.join("v1.log");
    let future_path = root.0.join("future.log");

    for (path, schema) in [
        (&v1_path, 4),
        (&future_path, codec::CURRENT_SCHEMA_VERSION + 1),
    ] {
        let mut content = Vec::from(codec::LOG_MAGIC);
        content.push(schema);
        content.extend_from_slice(&0_u64.to_le_bytes());
        fs::write(path, content).unwrap();
        assert!(matches!(
            FleetStore::open(path),
            Err(StoreFault::UnsupportedSchemaVersion(value)) if value == schema
        ));
    }
}

#[test]
fn authenticates_or_enrolls_ingress_without_exposing_credential_hashes() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let issued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let enrollment_hash = credential_hash('a');
    let first_ingress_hash = credential_hash('b');
    let replacement_hash = credential_hash('c');
    let replacement_enrollment = credential_hash('d');
    let mut store = FleetStore::open(&path).unwrap();
    install_topology_and_enrollments(
        &mut store,
        vec![
            EnrollmentRecord::restore(
                agent_id(),
                enrollment_hash.clone(),
                issued_at,
                issued_at + Duration::from_secs(60),
                None,
            )
            .unwrap(),
            EnrollmentRecord::restore(
                agent_id(),
                replacement_enrollment.clone(),
                issued_at + Duration::from_secs(4),
                issued_at + Duration::from_secs(60),
                None,
            )
            .unwrap(),
        ],
    );

    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                first_ingress_hash.clone(),
                Some(enrollment_hash.clone()),
                issued_at + Duration::from_secs(1),
            ))
            .unwrap(),
        IngressAuthentication::Authenticated {
            agent_id: agent_id(),
            enrollment: IngressEnrollment::Consumed,
            credential: IngressCredential::Issued,
        }
    );
    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                first_ingress_hash.clone(),
                None,
                issued_at + Duration::from_secs(2),
            ))
            .unwrap(),
        IngressAuthentication::Authenticated {
            agent_id: agent_id(),
            enrollment: IngressEnrollment::Existing,
            credential: IngressCredential::Existing,
        }
    );
    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                replacement_hash.clone(),
                Some(enrollment_hash),
                issued_at + Duration::from_secs(3),
            ))
            .unwrap(),
        IngressAuthentication::Unauthorized
    );

    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                replacement_hash.clone(),
                Some(replacement_enrollment),
                issued_at + Duration::from_secs(5),
            ))
            .unwrap(),
        IngressAuthentication::Authenticated {
            agent_id: agent_id(),
            enrollment: IngressEnrollment::Consumed,
            credential: IngressCredential::Replaced,
        }
    );
    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                first_ingress_hash.clone(),
                None,
                issued_at + Duration::from_secs(6),
            ))
            .unwrap(),
        IngressAuthentication::Unauthorized
    );
    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                other_agent_id(),
                replacement_hash.clone(),
                None,
                issued_at + Duration::from_secs(6),
            ))
            .unwrap(),
        IngressAuthentication::Unauthorized
    );
    let mut access = crate::topology::FleetAccessFacts::restore(
        store.facts().topology(),
        store
            .facts()
            .access()
            .enrollments()
            .cloned()
            .collect::<Vec<_>>(),
        store
            .facts()
            .access()
            .ingress_credentials()
            .cloned()
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert_eq!(
        access.revoke_ingress_credential(&replacement_hash, issued_at + Duration::from_secs(7)),
        IngressCredentialRevocation::Revoked
    );
    let topology = store.facts().topology().clone();
    store
        .transact(|facts| {
            *facts = super::FleetFacts::restore(super::FleetFactsRestoreInput {
                commands: Vec::new(),
                dispatches: Vec::new(),
                secret_references: Vec::new(),
                audit_entries: Vec::new(),
                topology,
                enrollments: access.enrollments().cloned().collect(),
                ingress_credentials: access.ingress_credentials().cloned().collect(),
                targets: Vec::new(),
                connections: Vec::new(),
                environments: Vec::new(),
                managed_resources: Vec::new(),
                effects: Vec::new(),
                runtime_agents: Vec::new(),
                runtime_agent_reachability: Vec::new(),
                leases: Vec::new(),
                bindings: Vec::new(),
            })?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                replacement_hash,
                None,
                issued_at + Duration::from_secs(8),
            ))
            .unwrap(),
        IngressAuthentication::Unauthorized
    );
    drop(store);

    let bytes = fs::read(&path).unwrap();
    assert!(
        !bytes
            .windows(INGRESS_RAW_INPUT_CANARY.len())
            .any(|window| window == INGRESS_RAW_INPUT_CANARY.as_bytes())
    );
    let reopened = FleetStore::open(&path).unwrap();
    let debug = format!("{:#?}", reopened.facts().access());
    assert!(!debug.contains(first_ingress_hash.as_str()));
    assert!(!debug.contains(INGRESS_RAW_INPUT_CANARY));
    assert_eq!(
        reopened
            .facts()
            .access()
            .ingress_credential(&credential_hash('c'))
            .expect("replacement credential persists")
            .revoked_at(),
        Some(issued_at + Duration::from_secs(7))
    );
}

#[test]
fn expired_enrollment_cannot_issue_ingress_credential() {
    let root = TestRoot::new();
    let issued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let enrollment_hash = credential_hash('e');
    let mut store = FleetStore::open(root.facts_path()).unwrap();
    install_topology_and_enrollment(
        &mut store,
        enrollment_hash.clone(),
        issued_at,
        issued_at + Duration::from_secs(1),
    );

    assert_eq!(
        store
            .authenticate_or_enroll_ingress(ingress_identity(
                agent_id(),
                credential_hash('f'),
                Some(enrollment_hash),
                issued_at + Duration::from_secs(1),
            ))
            .unwrap(),
        IngressAuthentication::Unauthorized
    );
}

#[test]
fn topology_and_credential_lifecycles_survive_an_atomic_replay_without_plaintext() {
    let root = TestRoot::new();
    let path = root.facts_path();
    let mut store = FleetStore::open(&path).unwrap();
    let enrollment_hash = credential_hash('a');
    let ingress_hash = credential_hash('b');
    let replacement_hash = credential_hash('c');
    let issued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let expires_at = issued_at + Duration::from_secs(60);
    let topology = topology();

    let mut access = crate::topology::FleetAccessFacts::restore(&topology, [], []).unwrap();
    assert_eq!(
        access.issue_enrollment(
            &topology,
            EnrollmentRecord::restore(
                agent_id(),
                enrollment_hash.clone(),
                issued_at,
                expires_at,
                None,
            )
            .unwrap(),
        ),
        Ok(())
    );
    assert_eq!(
        access.consume_enrollment(&enrollment_hash, issued_at + Duration::from_secs(1)),
        EnrollmentUse::Consumed
    );
    assert_eq!(
        access.consume_enrollment(&enrollment_hash, issued_at + Duration::from_secs(2)),
        EnrollmentUse::AlreadyConsumed
    );
    assert_eq!(
        access
            .issue_ingress_credential(
                &topology,
                IngressCredentialRecord::restore(
                    agent_id(),
                    ingress_hash.clone(),
                    issued_at,
                    None,
                )
                .unwrap(),
            )
            .unwrap(),
        IngressCredentialIssue::Issued
    );
    assert_eq!(
        access
            .issue_ingress_credential(
                &topology,
                IngressCredentialRecord::restore(
                    agent_id(),
                    replacement_hash.clone(),
                    issued_at + Duration::from_secs(3),
                    None,
                )
                .unwrap(),
            )
            .unwrap(),
        IngressCredentialIssue::Replaced
    );
    assert_eq!(
        access.revoke_ingress_credential(&replacement_hash, issued_at + Duration::from_secs(4)),
        IngressCredentialRevocation::Revoked
    );

    store
        .transact(|facts| {
            *facts = super::FleetFacts::restore(super::FleetFactsRestoreInput {
                commands: Vec::new(),
                dispatches: Vec::new(),
                secret_references: Vec::new(),
                audit_entries: Vec::new(),
                topology,
                enrollments: access.enrollments().cloned().collect(),
                ingress_credentials: access.ingress_credentials().cloned().collect(),
                targets: Vec::new(),
                connections: Vec::new(),
                environments: Vec::new(),
                managed_resources: Vec::new(),
                effects: Vec::new(),
                runtime_agents: Vec::new(),
                runtime_agent_reachability: Vec::new(),
                leases: Vec::new(),
                bindings: Vec::new(),
            })?;
            Ok(())
        })
        .unwrap();
    drop(store);

    let bytes = fs::read(&path).unwrap();
    assert!(!bytes.windows(6).any(|window| window == b"Bearer"));
    let reopened = FleetStore::open(&path).unwrap();
    assert_eq!(reopened.facts().topology().agents().len(), 1);
    assert_eq!(reopened.facts().topology().runtimes().len(), 1);
    let endpoint = &reopened.facts().topology().endpoints()[0];
    assert_eq!(endpoint.supported_capabilities().len(), 1);
    let capability = &endpoint.supported_capabilities()[0];
    assert_eq!(capability.id().as_str(), "session.prompt");
    assert_eq!(capability.scope(), CapabilityScope::Session);
    let availability = endpoint
        .availability_observation(capability)
        .expect("persisted capability availability observation must be present");
    assert_eq!(
        availability.availability(),
        CapabilityAvailability::Available
    );
    assert_eq!(
        availability.metadata().source(),
        ObservationSource::RuntimeAgent
    );
    assert_eq!(
        availability.metadata().observed_at(),
        SystemTime::UNIX_EPOCH
    );
    assert!(availability.authorizes_use());
    assert_eq!(reopened.facts().access().enrollments().count(), 1);
    let ingress = reopened
        .facts()
        .access()
        .ingress_credentials()
        .collect::<Vec<_>>();
    assert_eq!(ingress.len(), 2);
    assert_eq!(
        ingress[0].revoked_at(),
        Some(issued_at + Duration::from_secs(3))
    );
    assert_eq!(
        ingress[1].revoked_at(),
        Some(issued_at + Duration::from_secs(4))
    );
}

#[test]
fn enrollment_expiry_and_ingress_revocation_fail_closed() {
    let topology = topology();
    let issued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
    let hash = credential_hash('d');
    let mut access = crate::topology::FleetAccessFacts::restore(
        &topology,
        [EnrollmentRecord::restore(
            agent_id(),
            hash.clone(),
            issued_at,
            issued_at + Duration::from_secs(1),
            None,
        )
        .unwrap()],
        [
            IngressCredentialRecord::restore(agent_id(), credential_hash('e'), issued_at, None)
                .unwrap(),
        ],
    )
    .unwrap();

    assert_eq!(
        access.consume_enrollment(&hash, issued_at + Duration::from_secs(1)),
        EnrollmentUse::Expired
    );
    let ingress_hash = credential_hash('e');
    assert_eq!(
        access.revoke_ingress_credential(&ingress_hash, issued_at + Duration::from_secs(1)),
        IngressCredentialRevocation::Revoked
    );
    assert_eq!(
        access.revoke_ingress_credential(&ingress_hash, issued_at + Duration::from_secs(2)),
        IngressCredentialRevocation::AlreadyRevoked
    );
}

fn install_topology_and_enrollment(
    store: &mut FleetStore,
    enrollment_hash: CredentialHash,
    issued_at: SystemTime,
    expires_at: SystemTime,
) {
    install_topology_and_enrollments(
        store,
        vec![
            EnrollmentRecord::restore(agent_id(), enrollment_hash, issued_at, expires_at, None)
                .unwrap(),
        ],
    );
}

fn install_topology_and_enrollments(store: &mut FleetStore, enrollments: Vec<EnrollmentRecord>) {
    store
        .transact(|facts| {
            *facts = super::FleetFacts::restore(super::FleetFactsRestoreInput {
                commands: Vec::new(),
                dispatches: Vec::new(),
                secret_references: Vec::new(),
                audit_entries: Vec::new(),
                topology: topology(),
                enrollments,
                ingress_credentials: Vec::new(),
                targets: Vec::new(),
                connections: Vec::new(),
                environments: Vec::new(),
                managed_resources: Vec::new(),
                effects: Vec::new(),
                runtime_agents: Vec::new(),
                runtime_agent_reachability: Vec::new(),
                leases: Vec::new(),
                bindings: Vec::new(),
            })?;
            Ok(())
        })
        .unwrap();
}

fn ingress_identity(
    agent_id: NativeAgentId,
    presented_ingress_hash: CredentialHash,
    enrollment_hash: Option<CredentialHash>,
    at: SystemTime,
) -> AgentIngressIdentity {
    AgentIngressIdentity::new(agent_id, presented_ingress_hash, enrollment_hash, at)
}

fn topology() -> FleetTopologyFacts {
    let metadata = ObservationMetadata::new(
        ObservationSource::RuntimeAgent,
        SystemTime::UNIX_EPOCH,
        ObservationFreshness::Current,
    );
    FleetTopologyFacts::restore(
        vec![NodeObservation::new(
            NodeId::try_new("node-1").unwrap(),
            NodeHealth::Online {
                last_seen_at: SystemTime::UNIX_EPOCH,
            },
            metadata,
        )],
        vec![AgentObservation::new(
            agent_id(),
            NodeId::try_new("node-1").unwrap(),
            metadata,
        )],
        vec![RuntimeObservation::new(
            RuntimeId::try_new("runtime-1").unwrap(),
            NodeId::try_new("node-1").unwrap(),
            Some(agent_id()),
            RuntimeKind::OpenClaw,
            RuntimeState::Running {
                started_at: SystemTime::UNIX_EPOCH,
            },
            metadata,
        )],
        vec![EndpointObservation::new(
            EndpointId::try_new("endpoint-1").unwrap(),
            NodeId::try_new("node-1").unwrap(),
            RuntimeId::try_new("runtime-1").unwrap(),
            EndpointHealth::Ready,
            vec![SupportedCapability::new(
                CapabilityId::try_new("session.prompt").unwrap(),
                CapabilityScope::Session,
            )],
            vec![CapabilityAvailability::Available],
            metadata,
        )],
    )
    .unwrap()
}

fn agent_id() -> NativeAgentId {
    NativeAgentId::try_new("agent-1").unwrap()
}

fn other_agent_id() -> NativeAgentId {
    NativeAgentId::try_new("agent-2").unwrap()
}

fn credential_hash(character: char) -> CredentialHash {
    CredentialHash::try_new(character.to_string().repeat(64)).unwrap()
}

fn command() -> CommandIntent {
    CommandIntent::new(
        CommandId::try_new("command-1").unwrap(),
        IdempotencyKey::try_new("idempotency-1").unwrap(),
        CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
        CommandKind::ProbeNode,
        SystemTime::UNIX_EPOCH,
    )
}

fn dispatch_id() -> DispatchId {
    DispatchId::try_new("dispatch-1").unwrap()
}

fn audit_entry() -> FleetAuditEntry {
    FleetAuditEntry::try_new(
        1,
        FleetAuditEvent::new(FleetAuditEventInput {
            event_name: "command.queued".to_owned(),
            occurred_at: SystemTime::UNIX_EPOCH,
            message: Some(format!("Bearer {SECRET_CANARY}")),
            relations: crate::audit::FleetAuditRelations::default(),
            metadata: BTreeMap::from([(
                "authorization".to_owned(),
                FleetAuditValue::Text(SECRET_CANARY.to_owned()),
            )]),
        })
        .unwrap(),
    )
    .unwrap()
}

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

        let root = std::env::temp_dir().join(format!(
            "matcha-fleet-store-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn facts_path(&self) -> PathBuf {
        self.0.join("facts.log")
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
