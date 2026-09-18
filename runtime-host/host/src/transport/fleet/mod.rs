pub(crate) mod handler;
pub(crate) mod runtime_agent_ingress;
pub(crate) mod terminal_stream;

mod authorization;
mod dto;
mod mutation;
mod projection;
mod read;
mod terminal;

pub(crate) use dto::{DecodeError, Request};
pub(crate) use projection::Delivery;
pub(crate) use read::read;

#[cfg(test)]
use crate::fleet::owner::FleetTopologySummary;
#[cfg(test)]
use crate::transport::common::authorization::CapabilityDecisionVerifier;
#[cfg(test)]
use authorization::{
    AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, AUTHORIZATION_SUBJECT,
    MUTATION_AUTHORIZATION_SCOPE,
};
#[cfg(test)]
use dto::{Input, Operation};
#[cfg(test)]
use fleet::command::{CommandId, CommandKind, IdempotencyKey};
#[cfg(test)]
use fleet::connection::{ConnectionKind, ConnectionRecord};
#[cfg(test)]
use fleet::environment::{
    CleanupPolicy, EnvironmentKind, EnvironmentRecord, ManagedResourceKind,
    ManagedResourceProvider, Ownership,
};
#[cfg(test)]
use fleet::query::{CommandSummaryState, FleetQuerySnapshot};
#[cfg(test)]
use fleet::topology::NodeId;
#[cfg(test)]
use platform::capability::CapabilityAvailability;
#[cfg(test)]
use platform::endpoint::EndpointId;
#[cfg(test)]
use projection::{command_state_json, fleet_snapshot_json};
#[cfg(test)]
use serde_json::{Value, json};
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(test)]
use terminal::terminal_session_json;

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet},
        time::Duration,
    };

    use super::*;
    use crate::fleet::owner::FleetSnapshot;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use fleet::{
        audit::{FleetAuditEntry, FleetAuditEvent, FleetAuditEventInput, FleetAuditValue},
        command::{CommandIntent, CommandRecord, CommandTarget},
        environment::{EnvironmentState, ManagedResourceRecord},
        lease::{Lease, LeaseOwner, LeaseOwnerKind, LeaseState},
        store::{FleetFacts, FleetFactsRestoreInput},
        terminal::{
            Dimensions as TerminalDimensions, ProviderId as TerminalProviderId,
            SessionId as TerminalSessionId, TargetId as TerminalTargetId, TerminalSessionOwner,
        },
        topology::TopologyAssociation,
    };
    use platform::capability::{CapabilityId, CapabilityScope, SupportedCapability};
    use platform::endpoint::NativeAgentId;

    #[test]
    fn request_is_strict_and_operation_input_must_match() {
        let valid = json!({"operation":"fleet.connections.list","input":{"kind":"connections"}});
        let mut checked_verifier = verifier();
        assert!(
            Request::decode(
                valid,
                &decision("fleet.connections.list"),
                &mut checked_verifier,
                1
            )
            .is_ok()
        );

        for invalid in [
            json!({"operation":"fleet.connections.list","input":{"kind":"connections"},"id":"fleet"}),
            json!({"operation":"fleet.connections.list","input":{"kind":"resources"}}),
            json!({"operation":"fleet.unknown","input":{"kind":"connections"}}),
        ] {
            let mut verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision("fleet.connections.list"),
                    &mut verifier,
                    1
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn non_selector_read_operations_have_exact_input_kinds() {
        for (operation, kind) in [
            ("fleet.targets.list", "list"),
            ("fleet.topology.get", "topology"),
            ("fleet.connections.list", "connections"),
            ("fleet.capabilities.list", "capabilities"),
            ("fleet.environments.list", "environments"),
            ("fleet.resources.list", "resources"),
            ("fleet.commands.list", "commands"),
            ("fleet.audit.list", "audit"),
            ("fleet.leases.list", "leases"),
            ("fleet.metrics.get", "metrics"),
            ("fleet.snapshot.get", "snapshot"),
        ] {
            let mut verifier = verifier();
            assert!(
                Request::decode(
                    json!({"operation":operation,"input":{"kind":kind}}),
                    &decision(operation),
                    &mut verifier,
                    1
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn snapshot_read_requires_exact_capability_and_read_scope() {
        let request = json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot"}});
        let mut valid_verifier = verifier();
        assert!(
            Request::decode(
                request.clone(),
                &decision("fleet.snapshot.get"),
                &mut valid_verifier,
                1,
            )
            .is_ok()
        );

        for invalid in [
            json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot","extra":true}}),
            json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot"},"extra":true}),
            json!({"operation":"fleet.snapshot.get","input":{"kind":"metrics"}}),
        ] {
            let mut invalid_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision("fleet.snapshot.get"),
                    &mut invalid_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }

        let mut wrong_capability_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision("fleet.metrics.get"),
                &mut wrong_capability_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        let mut write_scope_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request,
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.snapshot.get",
                ),
                &mut write_scope_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn selector_preview_operation_requires_strict_selector_input() {
        let valid = json!({
            "operation": "fleet.selector.preview",
            "input": {"kind": "selectorPreview", "payload": {
                "endpointIds": ["endpoint-1"], "nodeIds": [], "runtimeIds": [],
                "labels": ["production"], "operationIds": []
            }}
        });
        let mut valid_verifier = verifier();
        assert!(
            Request::decode(
                valid,
                &decision("fleet.selector.preview"),
                &mut valid_verifier,
                1
            )
            .is_ok()
        );

        let mut invalid_verifier = verifier();
        assert!(matches!(
            Request::decode(
                json!({"operation":"fleet.selector.preview","input":{"kind":"selectorPreview","payload":{"endpointIds":[],"nodeIds":[],"runtimeIds":[],"labels":[],"operationIds":[],"extra":true}}}),
                &decision("fleet.selector.preview"),
                &mut invalid_verifier,
                1
            ),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn authorization_is_bound_to_route_scope_operation_and_subject() {
        let mut verifier = verifier();
        let error = Request::decode(
            json!({"operation":"fleet.connections.list","input":{"kind":"connections"}}),
            &decision_for("/api/other", "fleet:read", "fleet.connections.list"),
            &mut verifier,
            1,
        );
        assert!(matches!(error, Err(DecodeError::Unauthorized)));
    }

    #[test]
    fn mutation_operations_require_write_scope_and_reject_queued_at() {
        let input = json!({
            "operation":"fleet.commands.begin",
            "input":{"kind":"commandBegin","payload":{"dispatchId":"dispatch-1"}}
        });
        let mut read_verifier = verifier();
        assert!(matches!(
            Request::decode(
                input.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    AUTHORIZATION_SCOPE,
                    "fleet.commands.begin"
                ),
                &mut read_verifier,
                1
            ),
            Err(DecodeError::Unauthorized)
        ));

        let mut write_verifier = verifier();
        assert!(
            Request::decode(
                input,
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.commands.begin"
                ),
                &mut write_verifier,
                1
            )
            .is_ok()
        );

        let mut queued_at_verifier = verifier();
        assert!(matches!(
            Request::decode(
                json!({
                    "operation":"fleet.commands.begin",
                    "input":{"kind":"commandBegin","payload":{"dispatchId":"dispatch-1","queuedAt":1}}
                }),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.commands.begin"
                ),
                &mut queued_at_verifier,
                1
            ),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn connection_probe_operations_require_write_scope() {
        for (operation, input) in [
            (
                "fleet.connections.probe.begin",
                json!({
                    "operation": "fleet.connections.probe.begin",
                    "input": {
                        "kind": "connectionProbeBegin",
                        "payload": {"id": "connection-1", "commandId": "command-1"}
                    }
                }),
            ),
            (
                "fleet.connections.probe.complete",
                json!({
                    "operation": "fleet.connections.probe.complete",
                    "input": {
                        "kind": "connectionProbeComplete",
                        "payload": {
                            "id": "connection-1",
                            "commandId": "command-1",
                            "outcome": "ready"
                        }
                    }
                }),
            ),
        ] {
            let mut read_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    input.clone(),
                    &decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, operation),
                    &mut read_verifier,
                    1,
                ),
                Err(DecodeError::Unauthorized)
            ));

            let mut write_verifier = verifier();
            assert!(
                Request::decode(
                    input,
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        operation,
                    ),
                    &mut write_verifier,
                    1,
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn runtime_and_capability_begin_operations_require_write_scope_and_exact_signed_binding() {
        for (operation, kind, mismatched_kind, expected_operation) in [
            (
                "fleet.runtimes.start.begin",
                "runtimeStartBegin",
                "runtimeStopBegin",
                Operation::RuntimeStartBegin,
            ),
            (
                "fleet.runtimes.stop.begin",
                "runtimeStopBegin",
                "runtimeStartBegin",
                Operation::RuntimeStopBegin,
            ),
            (
                "fleet.capabilities.sync.begin",
                "capabilitySyncBegin",
                "runtimeStartBegin",
                Operation::CapabilitySyncBegin,
            ),
        ] {
            let request = json!({
                "operation": operation,
                "input": {
                    "kind": kind,
                    "payload": {"id": "runtime-1", "commandId": "command-1"}
                }
            });
            let mut valid_verifier = verifier();
            let decoded = Request::decode(
                request.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    operation,
                ),
                &mut valid_verifier,
                1,
            )
            .expect("write-scoped Fleet begin request should decode");
            assert_eq!(decoded.operation, expected_operation);

            for authorization in [
                decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, operation),
                decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.commands.begin",
                ),
                decision_for("/api/other", MUTATION_AUTHORIZATION_SCOPE, operation),
                decision_for_subject(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    operation,
                    "not-fleet",
                ),
            ] {
                let mut rejected_verifier = verifier();
                assert!(matches!(
                    Request::decode(request.clone(), &authorization, &mut rejected_verifier, 1),
                    Err(DecodeError::Unauthorized)
                ));
            }

            let mut mismatched_input_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    json!({
                        "operation": operation,
                        "input": {
                            "kind": mismatched_kind,
                            "payload": {"id": "runtime-1", "commandId": "command-1"}
                        }
                    }),
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        operation,
                    ),
                    &mut mismatched_input_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn terminal_close_requires_exact_write_contract() {
        let request = json!({
            "operation": "fleet.terminals.close",
            "input": {
                "kind": "terminalClose",
                "payload": {"sessionId": "session-1"}
            }
        });
        let mut valid_verifier = verifier();
        let decoded = Request::decode(
            request.clone(),
            &decision_for(
                AUTHORIZATION_ENDPOINT,
                MUTATION_AUTHORIZATION_SCOPE,
                "fleet.terminals.close",
            ),
            &mut valid_verifier,
            1,
        )
        .expect("single terminal close request should decode");
        assert!(matches!(decoded.operation, Operation::TerminalClose));
        assert!(matches!(
            decoded.input,
            Input::TerminalClose { payload } if payload.session_id == "session-1"
        ));

        let mut read_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    AUTHORIZATION_SCOPE,
                    "fleet.terminals.close",
                ),
                &mut read_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        let mut wrong_capability_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision("fleet.terminals.close.complete"),
                &mut wrong_capability_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        for invalid in [
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalClose",
                    "payload": {"sessionId": "session-1", "reason": "done"}
                }
            }),
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalClose",
                    "payload": {"sessionId": "session-1"},
                    "extra": true
                }
            }),
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalClose",
                    "payload": {"sessionId": "session-1"}
                },
                "extra": true
            }),
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalBeginClose",
                    "payload": {"sessionId": "session-1"}
                }
            }),
        ] {
            let mut invalid_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        "fleet.terminals.close",
                    ),
                    &mut invalid_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn terminal_close_delivery_is_sealed_and_uses_public_failures() {
        let success = Delivery::Mutation(json!({"outcome":"terminalClosed"}));
        assert_eq!(success.status_code(), 200);
        assert_eq!(success.body(), json!({"outcome":"terminalClosed"}));

        let failure = Delivery::Mutation(json!({"outcome":"error"}));
        assert_eq!(failure.status_code(), 200);
        assert_eq!(failure.body(), json!({"outcome":"error"}));

        let unavailable = Delivery::Unavailable;
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(
            unavailable.body(),
            json!({"success":false,"error":"Fleet data is unavailable"})
        );
    }

    #[test]
    fn terminal_session_projection_uses_public_websocket_path() {
        assert!(handler::is_terminal_route(
            "GET",
            crate::transport::fleet::terminal_stream::TERMINAL_WEBSOCKET_PATH
        ));
        assert!(handler::is_terminal_route(
            "GET",
            crate::transport::fleet::terminal_stream::PRIVATE_TERMINAL_WEBSOCKET_PATH
        ));

        let mut owner = TerminalSessionOwner::default();
        let opened = owner
            .open(
                TerminalSessionId::try_new("session-1").unwrap(),
                TerminalTargetId::try_new("target-1").unwrap(),
                TerminalProviderId::try_new("docker").unwrap(),
                TerminalDimensions::try_new(24, 80).unwrap(),
                SystemTime::UNIX_EPOCH + Duration::from_secs(1),
            )
            .unwrap();
        let context = crate::fleet::terminal::TerminalContext {
            session: opened.session.id().clone(),
            target: opened.session.target().clone(),
            provider: opened.session.provider().clone(),
            generation: opened.session.generation(),
            node: NodeId::try_new("node-1").unwrap(),
            endpoint: EndpointId::try_new("endpoint-1").unwrap(),
            rows: 24,
            cols: 80,
        };

        let value = terminal_session_json("terminalOpened", &opened, &context);

        assert_eq!(
            value["terminalConnection"]["websocketPath"],
            json!(crate::transport::fleet::terminal_stream::TERMINAL_WEBSOCKET_PATH)
        );
    }

    #[test]
    fn sensitive_fields_are_not_present_in_safe_command_projection() {
        let state = CommandSummaryState::Failed {
            completed_at: SystemTime::UNIX_EPOCH,
            failure: fleet::command::CommandFailure::ExecutionFailed,
        };
        let value = command_state_json(&state);
        assert_eq!(
            value,
            json!({
                "kind":"failed",
                "completedAt":"unix:0",
                "failure":"executionFailed"
            })
        );
    }

    #[test]
    fn fleet_snapshot_is_source_backed_and_sealed_field_by_field() {
        let snapshot = snapshot_fixture();
        let value = fleet_snapshot_json(&snapshot);

        assert_exact_keys(
            &value,
            [
                "connections",
                "environments",
                "managedResources",
                "nodes",
                "agents",
                "runtimes",
                "endpoints",
                "capabilities",
                "commands",
                "leases",
                "sessions",
                "auditEvents",
                "updatedAt",
            ],
        );
        assert_eq!(value["updatedAt"], json!("unix:9000"));

        let connection = record_by_id(&value["connections"], "connection-1");
        assert_exact_keys(
            connection,
            [
                "id",
                "displayName",
                "connectionKind",
                "status",
                "labels",
                "enabled",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_eq!(connection["status"], json!("unknown"));
        assert!(!connection.as_object().unwrap().contains_key("endpoint"));
        assert!(!connection.as_object().unwrap().contains_key("publicConfig"));
        assert!(!connection.as_object().unwrap().contains_key("secretRefs"));

        let environment = record_by_id(&value["environments"], "environment-1");
        assert_exact_keys(
            environment,
            [
                "id",
                "connectionId",
                "displayName",
                "environmentKind",
                "status",
                "labels",
                "enabled",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_eq!(environment["status"], json!("ready"));
        assert!(
            !environment
                .as_object()
                .unwrap()
                .contains_key("publicConfig")
        );
        assert!(!environment.as_object().unwrap().contains_key("secretRefs"));

        let resource = record_by_id(&value["managedResources"], "resource-1");
        assert_exact_keys(
            resource,
            [
                "id",
                "connectionId",
                "environmentId",
                "nodeId",
                "providerKind",
                "resourceKind",
                "remoteResourceId",
                "displayName",
                "status",
                "ownership",
                "cleanupPolicy",
                "labels",
                "createdAt",
                "updatedAt",
                "lastObservedAt",
            ],
        );

        let node = record_by_id(&value["nodes"], "node-1");
        assert_exact_keys(
            node,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "status",
                "lastSeenAt",
            ],
        );
        let agent = record_by_id(&value["agents"], "agent-1");
        assert_exact_keys(
            agent,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
            ],
        );
        let runtime = record_by_id(&value["runtimes"], "runtime-1");
        assert_exact_keys(
            runtime,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "agentId",
                "status",
                "startedAt",
            ],
        );
        assert_eq!(runtime["startedAt"], json!("unix:2000"));
        let stopped_runtime = record_by_id(&value["runtimes"], "runtime-stopped");
        assert_exact_keys(
            stopped_runtime,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "agentId",
                "status",
                "startedAt",
            ],
        );
        assert_eq!(stopped_runtime["status"], json!("stopped"));
        assert_eq!(stopped_runtime["startedAt"], Value::Null);
        let endpoint = record_by_id(&value["endpoints"], "endpoint-1");
        assert_exact_keys(
            endpoint,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "runtimeId",
                "status",
                "lastProbeAt",
            ],
        );
        let capability = record_by_id(&value["capabilities"], "session.prompt");
        assert_exact_keys(
            &capability,
            ["id", "endpointId", "nodeId", "runtimeId", "status"],
        );
        assert_eq!(capability["status"], json!("current"));

        for (id, expected_keys) in [
            (
                "command-node",
                vec![
                    "id",
                    "command",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "nodeId",
                ],
            ),
            (
                "command-runtime",
                vec![
                    "id",
                    "command",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "nodeId",
                    "runtimeId",
                ],
            ),
            (
                "command-endpoint",
                vec![
                    "id",
                    "command",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "nodeId",
                    "runtimeId",
                    "endpointId",
                ],
            ),
        ] {
            let command = record_by_id(&value["commands"], id);
            assert_exact_keys(command, expected_keys);
            for forbidden in [
                "idempotencyKey",
                "input",
                "payload",
                "effect",
                "error",
                "stdout",
                "stderr",
                "log",
            ] {
                assert!(!command.as_object().unwrap().contains_key(forbidden));
            }
        }

        for lease_id in ["lease-released", "lease-expired"] {
            let lease = record_by_id(&value["leases"], lease_id);
            assert_exact_keys(
                lease,
                [
                    "id",
                    "endpointId",
                    "ownerKind",
                    "ownerId",
                    "status",
                    "expiresAt",
                ],
            );
            assert_eq!(lease["expiresAt"], Value::Null);
        }

        let session = record_by_id(&value["sessions"], "session-1");
        assert_exact_keys(
            session,
            [
                "id",
                "nodeId",
                "status",
                "createdAt",
                "updatedAt",
                "expiresAt",
            ],
        );
        assert_eq!(session["nodeId"], json!("node-1"));
        for forbidden in ["targetId", "provider", "dimensions", "generation", "ticket"] {
            assert!(!session.as_object().unwrap().contains_key(forbidden));
        }

        let audit = record_by_id(&value["auditEvents"], "audit:1");
        assert_exact_keys(
            audit,
            [
                "id",
                "eventName",
                "occurredAt",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "agentId",
                "runtimeId",
                "endpointId",
                "commandId",
            ],
        );
        for forbidden in ["message", "metadata", "stdout", "stderr", "log"] {
            assert!(!audit.as_object().unwrap().contains_key(forbidden));
        }
    }

    fn snapshot_fixture() -> FleetSnapshot {
        let created_at = UNIX_EPOCH + Duration::from_millis(1000);
        let observed_at = UNIX_EPOCH + Duration::from_millis(2000);
        let snapshot_at = UNIX_EPOCH + Duration::from_millis(9000);
        let connection_id = fleet::connection::ConnectionId::try_new("connection-1").unwrap();
        let environment_id = fleet::environment::EnvironmentId::try_new("environment-1").unwrap();
        let resource_id = fleet::environment::ManagedResourceId::try_new("resource-1").unwrap();
        let node_id = fleet::topology::NodeId::try_new("node-1").unwrap();
        let runtime_id = fleet::topology::RuntimeId::try_new("runtime-1").unwrap();
        let endpoint_id = EndpointId::try_new("endpoint-1").unwrap();
        let agent_id = NativeAgentId::try_new("agent-1").unwrap();
        let association = TopologyAssociation::new(
            Some(connection_id.clone()),
            Some(environment_id.clone()),
            Some(resource_id.clone()),
        );
        let metadata = fleet::topology::ObservationMetadata::new(
            fleet::topology::ObservationSource::RuntimeAgent,
            observed_at,
            fleet::topology::ObservationFreshness::Current,
        );
        let topology = fleet::topology::FleetTopologyFacts::restore(
            vec![fleet::topology::NodeObservation::with_association(
                node_id.clone(),
                association.clone(),
                fleet::topology::NodeHealth::Online {
                    last_seen_at: observed_at,
                },
                metadata,
            )],
            vec![fleet::topology::AgentObservation::with_association(
                agent_id.clone(),
                node_id.clone(),
                association.clone(),
                metadata,
            )],
            vec![
                fleet::topology::RuntimeObservation::with_association(
                    runtime_id.clone(),
                    node_id.clone(),
                    Some(agent_id.clone()),
                    association.clone(),
                    fleet::topology::RuntimeKind::OpenClaw,
                    fleet::topology::RuntimeState::Running {
                        started_at: observed_at,
                    },
                    metadata,
                ),
                fleet::topology::RuntimeObservation::with_association(
                    fleet::topology::RuntimeId::try_new("runtime-stopped").unwrap(),
                    node_id.clone(),
                    Some(agent_id.clone()),
                    association.clone(),
                    fleet::topology::RuntimeKind::OpenClaw,
                    fleet::topology::RuntimeState::Stopped {
                        stopped_at: Some(snapshot_at),
                    },
                    metadata,
                ),
            ],
            vec![fleet::topology::EndpointObservation::with_association(
                endpoint_id.clone(),
                node_id.clone(),
                runtime_id.clone(),
                association.clone(),
                fleet::topology::EndpointHealth::Ready,
                vec![SupportedCapability::new(
                    CapabilityId::try_new("session.prompt").unwrap(),
                    CapabilityScope::Session,
                )],
                vec![CapabilityAvailability::Available],
                metadata,
            )],
        )
        .unwrap();
        let connection = ConnectionRecord::register(
            connection_id.clone(),
            ConnectionKind::SshHost,
            "SSH connection".to_owned(),
            Some("ssh://internal.example".to_owned()),
            vec!["production".to_owned()],
            true,
            BTreeMap::from([(String::from("region"), String::from("private-region"))]),
            BTreeMap::new(),
            created_at,
        )
        .unwrap();
        let environment = EnvironmentRecord::restore(
            environment_id.clone(),
            connection_id.clone(),
            "Workspace".to_owned(),
            EnvironmentKind::SshWorkdir,
            vec!["production".to_owned()],
            true,
            BTreeMap::from([(String::from("root"), String::from("private-root"))]),
            BTreeMap::new(),
            EnvironmentState::Ready {
                ready_at: observed_at,
            },
            vec![resource_id.clone()],
            created_at,
            observed_at,
        )
        .unwrap();
        let resource = ManagedResourceRecord::new(
            resource_id.clone(),
            connection_id.clone(),
            environment_id.clone(),
            ManagedResourceProvider::Ssh,
            ManagedResourceKind::SshAgentInstallation,
            "remote-agent-1".to_owned(),
            Ownership::MatchaManaged,
            CleanupPolicy::UninstallAgentOnly,
            created_at,
        );
        let commands = vec![
            CommandRecord::queued(CommandIntent::new(
                CommandId::try_new("command-node").unwrap(),
                IdempotencyKey::try_new("key-node").unwrap(),
                CommandTarget::Node(node_id.clone()),
                CommandKind::ProbeNode,
                created_at,
            )),
            CommandRecord::queued(CommandIntent::new(
                CommandId::try_new("command-runtime").unwrap(),
                IdempotencyKey::try_new("key-runtime").unwrap(),
                CommandTarget::Runtime {
                    node_id: node_id.clone(),
                    runtime_id: runtime_id.clone(),
                },
                CommandKind::StartRuntime,
                created_at,
            )),
            CommandRecord::queued(CommandIntent::new(
                CommandId::try_new("command-endpoint").unwrap(),
                IdempotencyKey::try_new("key-endpoint").unwrap(),
                CommandTarget::Endpoint {
                    node_id: node_id.clone(),
                    runtime_id: runtime_id.clone(),
                    endpoint_id: endpoint_id.clone(),
                },
                CommandKind::SyncCapabilities,
                created_at,
            )),
        ];
        let relations = fleet::audit::FleetAuditRelations::new(
            Some(String::from("actor-1")),
            Some(connection_id.as_str().to_owned()),
            Some(environment_id.as_str().to_owned()),
            Some(resource_id.as_str().to_owned()),
            Some(node_id.as_str().to_owned()),
            Some(agent_id.as_str().to_owned()),
            Some(runtime_id.as_str().to_owned()),
            Some(endpoint_id.as_str().to_owned()),
            Some(String::from("command-node")),
        )
        .unwrap();
        let audit = FleetAuditEntry::try_new(
            1,
            FleetAuditEvent::new(FleetAuditEventInput {
                event_name: String::from("command.queued"),
                occurred_at: observed_at,
                message: Some(String::from("internal execution detail")),
                metadata: BTreeMap::from([(
                    String::from("internal"),
                    FleetAuditValue::Text(String::from("private detail")),
                )]),
                relations,
            })
            .unwrap(),
        )
        .unwrap();
        let owner = LeaseOwner::try_new(LeaseOwnerKind::Session, "session-1").unwrap();
        let leases = vec![
            Lease::restore(
                fleet::lease::LeaseId::try_new("lease-released").unwrap(),
                endpoint_id.clone(),
                owner.clone(),
                created_at,
                LeaseState::Released {
                    released_at: observed_at,
                },
            )
            .unwrap(),
            Lease::restore(
                fleet::lease::LeaseId::try_new("lease-expired").unwrap(),
                endpoint_id.clone(),
                owner,
                created_at,
                LeaseState::Expired {
                    expired_at: observed_at,
                },
            )
            .unwrap(),
        ];
        let facts = FleetFacts::restore(FleetFactsRestoreInput {
            commands,
            dispatches: Vec::new(),
            secret_references: Vec::new(),
            audit_entries: vec![audit],
            topology,
            enrollments: Vec::new(),
            ingress_credentials: Vec::new(),
            targets: Vec::new(),
            connections: vec![connection],
            environments: vec![environment],
            managed_resources: vec![resource],
            effects: Vec::new(),
            runtime_agents: Vec::new(),
            runtime_agent_reachability: Vec::new(),
            leases,
            bindings: Vec::new(),
        })
        .unwrap();
        let query = FleetQuerySnapshot::from_facts(&facts, facts.leases(), snapshot_at);
        let mut terminal = TerminalSessionOwner::default();
        let session = terminal
            .open(
                TerminalSessionId::try_new("session-1").unwrap(),
                TerminalTargetId::try_new("node-1").unwrap(),
                TerminalProviderId::try_new("ssh").unwrap(),
                TerminalDimensions::try_new(24, 80).unwrap(),
                created_at,
            )
            .unwrap()
            .session;
        FleetSnapshot {
            query,
            topology: FleetTopologySummary {
                nodes: facts.topology().nodes().to_vec(),
                agents: facts.topology().agents().to_vec(),
                runtimes: facts.topology().runtimes().to_vec(),
                endpoints: facts.topology().endpoints().to_vec(),
            },
            sessions: vec![session],
            updated_at: snapshot_at,
        }
    }

    fn record_by_id<'a>(value: &'a Value, id: &str) -> &'a Value {
        value
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record.get("id") == Some(&json!(id)))
            .unwrap_or_else(|| panic!("missing record {id}"))
    }

    fn assert_exact_keys<I>(value: &Value, expected: I)
    where
        I: IntoIterator<Item = &'static str>,
    {
        let actual = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let expected = expected.into_iter().collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[41; 32])
    }
    fn verifier() -> CapabilityDecisionVerifier {
        CapabilityDecisionVerifier::try_new(&verification_key()).unwrap()
    }
    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }
    fn decision(operation: &str) -> String {
        decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, operation)
    }
    fn decision_for(endpoint: &str, scope: &str, operation: &str) -> String {
        decision_for_subject(endpoint, scope, operation, AUTHORIZATION_SUBJECT)
    }
    fn decision_for_subject(endpoint: &str, scope: &str, operation: &str, subject: &str) -> String {
        let payload = json!({"version":1,"principal":"test","endpoint":endpoint,"scope":scope,"capability":operation,"subject":subject,"expiresAt":60_000,"correlation":format!("fleet-{operation}"),"revision":"test"});
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
