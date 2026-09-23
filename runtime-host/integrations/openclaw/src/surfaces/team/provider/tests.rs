use platform::state_dir::CanonicalStateDir;
use std::{
    fmt::Debug,
    fs,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use organization::{
    IdempotencyKey, MaterializationOperationOutcome, MaterializationSource,
    RoleAgentMaterialization, RuntimeEndpointReference, TeamId, TeamMaterializationIntent,
    TeamMaterializationRequest,
};

use crate::{
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
        wire,
    },
    team::{ResolvedWorkspace, TeamRecoveryOutcome, TeamRecoveryRequest, TeamRecoveryRole},
};

#[tokio::test(flavor = "current_thread")]
async fn list_projects_only_safe_agent_ids_after_correlated_pinned_tls_rpc() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": "unrelated", "ok": true, "payload": {}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "agent-team", "workspace": "private-workspace-canary"}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let agents = test_provider(&client).list_agents().await.unwrap();
    drop(client);
    server.await.unwrap();

    assert_eq!(agents.as_slice().len(), 1);
    assert_eq!(agents.as_slice()[0].id().as_str(), "agent-team");
    assert!(!format!("{:?}", agents.as_slice()[0].id()).contains("private-workspace-canary"));
}

#[tokio::test(flavor = "current_thread")]
async fn recover_requires_complete_unique_native_agent_workspace_facts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [
                        {"id": "agent-lead", "workspace": "private-workspace-lead"},
                        {"id": "agent-review", "workspace": "private-workspace-review"},
                        {"id": "agent-unrelated", "workspace": "private-workspace-unrelated"}
                    ]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .recover(
            TeamRecoveryRequest::try_new(
                "team-release",
                vec![
                    TeamRecoveryRole::try_new("lead", "agent-lead").unwrap(),
                    TeamRecoveryRole::try_new("review", "agent-review").unwrap(),
                ],
            )
            .unwrap(),
        )
        .await;
    drop(client);
    server.await.unwrap();

    let Ok(TeamRecoveryOutcome::Recovered(recovery)) = outcome else {
        panic!("expected verified team recovery");
    };
    assert_eq!(recovery.team().as_str(), "team-release");
    assert_eq!(recovery.roles().len(), 2);
    assert_eq!(recovery.roles()[0].role().as_str(), "lead");
    assert_eq!(recovery.roles()[0].agent().as_str(), "agent-lead");
    assert_eq!(
        recovery.roles()[0].workspace().as_str(),
        "private-workspace-lead"
    );
    assert_eq!(recovery.roles()[1].role().as_str(), "review");
    assert_eq!(recovery.roles()[1].agent().as_str(), "agent-review");
    assert_eq!(
        recovery.roles()[1].workspace().as_str(),
        "private-workspace-review"
    );
    for canary in [
        "agent-lead",
        "private-workspace-lead",
        "private-workspace-review",
    ] {
        assert!(!format!("{recovery:?}").contains(canary));
    }
}

#[test]
fn recovery_keeps_incomplete_or_ambiguous_native_facts_unknown_without_private_leaks() {
    let single_role_request = TeamRecoveryRequest::try_new(
        "team-release",
        vec![TeamRecoveryRole::try_new("lead", "agent-lead").unwrap()],
    )
    .unwrap();

    for agents in [
        TeamAgents::new(vec![]),
        TeamAgents::new(vec![TeamAgent::new(
            "agent-other".into(),
            Some("private-workspace-other".into()),
        )]),
        TeamAgents::new(vec![TeamAgent::new("agent-lead".into(), None)]),
        TeamAgents::new(vec![
            TeamAgent::new("agent-lead".into(), Some("private-workspace-lead".into())),
            TeamAgent::new("agent-lead".into(), Some("private-workspace-other".into())),
        ]),
        TeamAgents::new(vec![
            TeamAgent::new("agent-lead".into(), Some("private-workspace-lead".into())),
            TeamAgent::new(
                "agent-unrelated".into(),
                Some("private-workspace-unrelated".into()),
            ),
            TeamAgent::new(
                "agent-unrelated".into(),
                Some("private-workspace-duplicate".into()),
            ),
        ]),
        TeamAgents::new(vec![
            TeamAgent::new("agent-lead".into(), Some("private-workspace-shared".into())),
            TeamAgent::new(
                "agent-unrelated".into(),
                Some("private-workspace-shared".into()),
            ),
        ]),
    ] {
        let outcome = agents.recover(single_role_request.clone());
        assert!(matches!(outcome, TeamRecoveryOutcome::Unknown));
        for canary in [
            "agent-lead",
            "agent-unrelated",
            "private-workspace-lead",
            "private-workspace-other",
            "private-workspace-unrelated",
            "private-workspace-duplicate",
        ] {
            assert!(!format!("{outcome:?}").contains(canary));
        }
    }

    let shared_workspace_request = TeamRecoveryRequest::try_new(
        "team-release",
        vec![
            TeamRecoveryRole::try_new("lead", "agent-lead").unwrap(),
            TeamRecoveryRole::try_new("review", "agent-review").unwrap(),
        ],
    )
    .unwrap();
    let agents = TeamAgents::new(vec![
        TeamAgent::new("agent-lead".into(), Some("private-workspace-shared".into())),
        TeamAgent::new(
            "agent-review".into(),
            Some("private-workspace-shared".into()),
        ),
    ]);

    assert!(matches!(
        agents.recover(shared_workspace_request),
        TeamRecoveryOutcome::Unknown
    ));
}

#[test]
fn recovery_request_rejects_multiple_roles_bound_to_the_same_native_agent() {
    assert!(
        TeamRecoveryRequest::try_new(
            "team-release",
            vec![
                TeamRecoveryRole::try_new("lead", "agent-shared").unwrap(),
                TeamRecoveryRole::try_new("review", "agent-shared").unwrap(),
            ],
        )
        .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn materialization_readback_confirms_only_matching_external_agent_and_marker() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let state_dir = test_state_dir();
    let workspace = std::env::temp_dir().join("matchaclaw-team-recovery-external-marker");
    fs::create_dir_all(&workspace).unwrap();
    TeamBuddyMarker::new(
        TeamId::try_new("team:recovery").unwrap(),
        organization::RoleId::try_new("reviewer").unwrap(),
    )
    .write(&workspace)
    .unwrap();
    let acceptor = identity.acceptor();
    let workspace_wire = workspace.to_string_lossy().to_string();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "existing-reviewer", "workspace": workspace_wire}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let request = TeamMaterializationRequest::new(
        TeamMaterializationIntent::try_new(
            TeamId::try_new("team:recovery").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            MaterializationSource::Manual,
            vec![RoleAgentMaterialization::external(
                organization::RoleId::try_new("reviewer").unwrap(),
                organization::ManagedAgentReference::try_new("existing-reviewer").unwrap(),
            )],
        )
        .unwrap(),
        IdempotencyKey::try_new("materialize:recovery").unwrap(),
    );

    let outcome = TeamProvider::new(&client, state_dir)
        .recover_materialization(request)
        .await;
    drop(client);
    server.await.unwrap();
    fs::remove_dir_all(&workspace).unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { ref receipt }
            if receipt.roles()[0].agent().as_str() == "existing-reviewer"
                && receipt.roles()[0].ownership() == organization::RoleMaterializationOwnership::External
                && receipt.roles()[0].native_workspace().map(organization::NativeWorkspaceReceipt::as_str) == Some(workspace.to_string_lossy().as_ref())
    ));
    assert!(!format!("{outcome:?}").contains(workspace.to_string_lossy().as_ref()));
}

#[tokio::test(flavor = "current_thread")]
async fn materialization_readback_keeps_missing_marker_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let state_dir = test_state_dir();
    let workspace = std::env::temp_dir().join("matchaclaw-team-recovery-missing-marker");
    fs::create_dir_all(&workspace).unwrap();
    let acceptor = identity.acceptor();
    let workspace_wire = workspace.to_string_lossy().to_string();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "existing-reviewer", "workspace": workspace_wire}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let request = TeamMaterializationRequest::new(
        TeamMaterializationIntent::try_new(
            TeamId::try_new("team:recovery").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            MaterializationSource::Manual,
            vec![RoleAgentMaterialization::external(
                organization::RoleId::try_new("reviewer").unwrap(),
                organization::ManagedAgentReference::try_new("existing-reviewer").unwrap(),
            )],
        )
        .unwrap(),
        IdempotencyKey::try_new("materialize:recovery").unwrap(),
    );

    let outcome = TeamProvider::new(&client, state_dir)
        .recover_materialization(request)
        .await;
    drop(client);
    server.await.unwrap();
    fs::remove_dir_all(&workspace).unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_materialization_recovery_does_not_guess_an_agent_from_native_list_facts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let request = TeamMaterializationRequest::new(
        TeamMaterializationIntent::try_new(
            TeamId::try_new("team:recovery").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            MaterializationSource::TeamSkill,
            vec![
                RoleAgentMaterialization::managed(
                    organization::RoleId::try_new("reviewer").unwrap(),
                    "requested-reviewer",
                )
                .unwrap(),
            ],
        )
        .unwrap(),
        IdempotencyKey::try_new("materialize:recovery").unwrap(),
    );

    let outcome = TeamProvider::new(&client, test_state_dir())
        .recover_materialization(request)
        .await;

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn materialization_port_rejects_managed_collision_without_writing() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.create");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": false,
                "error": {"code": "ALREADY_EXISTS", "message": "agent exists"}
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("reviewer").unwrap(),
                "managed-reviewer",
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let provider = test_provider(&client);
    let outcome = provider
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("run-42:reviewer:1").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Rejected { .. }
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn materialization_port_confirms_external_agent_and_writes_its_marker() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "external-reviewer", "workspace": "private-workspace-canary"}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "external-reviewer", "workspace": "private-workspace-canary"}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![RoleAgentMaterialization::external(
            organization::RoleId::try_new("reviewer").unwrap(),
            organization::ManagedAgentReference::try_new("external-reviewer").unwrap(),
        )],
    )
    .unwrap();

    let outcome = test_provider(&client)
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("run-42:reviewer:1").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { ref receipt }
            if receipt.roles().len() == 1
                && receipt.roles()[0].agent().as_str() == "external-reviewer"
                && receipt.roles()[0].ownership() == organization::RoleMaterializationOwnership::External
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_materialization_uses_team_and_role_projected_workspace() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;

        let request = read_json(&mut socket).await;
        assert_team_request(&request, "agents.create");
        assert_eq!(
            request["params"],
            json!({"name": "managed-reviewer", "workspace": request["params"]["workspace"]})
        );
        let workspace = request["params"]["workspace"].clone();
        let workspace_path = workspace.as_str().unwrap();
        assert!(workspace_path.contains("teambuddy"));
        assert!(!workspace_path.contains("team-release"));
        assert!(!workspace_path.contains("reviewer"));
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "ok": true, "agentId": "managed-reviewer", "name": "managed-reviewer",
                    "workspace": workspace.clone(), "model": null
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_team_request(&request, "agents.update");
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        assert_eq!(request["params"]["name"], "managed-reviewer");
        assert!(
            request["params"]["workspace"]
                .as_str()
                .unwrap()
                .contains("teambuddy")
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer"}}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_team_request(&request, "config.get");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": materialization_config_snapshot_payload()
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let config: Value =
            serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(config.as_object().unwrap().len(), 1);
        assert_eq!(config["agents"].as_object().unwrap().len(), 1);
        assert_eq!(config["agents"]["list"][0]["id"], "managed-reviewer");
        assert_eq!(config["agents"]["list"][0]["name"], "managed-reviewer");
        assert!(
            config["agents"]["list"][0]["workspace"]
                .as_str()
                .unwrap()
                .contains("teambuddy")
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {"ok": true, "path": "config-path-canary", "config": {}}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_team_request(&request, "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "managed-reviewer", "workspace": workspace}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("reviewer").unwrap(),
                "managed-reviewer",
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let provider = test_provider(&client);

    let outcome = provider
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("run-42:reviewer:1").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    match outcome {
        MaterializationOperationOutcome::Confirmed { receipt } => {
            assert_eq!(receipt.roles().len(), 1);
            assert_eq!(receipt.roles()[0].role().as_str(), "reviewer");
            assert_eq!(receipt.roles()[0].agent().as_str(), "managed-reviewer");
            assert_eq!(
                receipt.roles()[0].ownership(),
                organization::RoleMaterializationOwnership::Managed
            );
            let workspace = receipt.roles()[0]
                .native_workspace()
                .expect("managed materialization must record confirmed workspace")
                .as_str();
            assert!(workspace.contains("teambuddy"));
            assert!(!format!("{receipt:?}").contains(workspace));
        }
        unexpected => panic!("expected confirmed materialization receipt, got {unexpected:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn managed_materialization_writes_its_marker_only_after_gateway_mutations() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let state_dir = test_state_dir();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let workspace = request["params"]["workspace"].clone();
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "ok": true, "agentId": "managed-reviewer", "name": "managed-reviewer",
                    "workspace": workspace.clone(), "model": null
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer"}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": materialization_config_snapshot_payload()}),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "managed-reviewer", "workspace": workspace}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("reviewer").unwrap(),
                "managed-reviewer",
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let provider = TeamProvider::new(&client, state_dir.clone());

    let outcome = provider
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("run-42:reviewer:marker").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { ref receipt }
            if receipt.roles().len() == 1
                && receipt.roles()[0].agent().as_str() == "managed-reviewer"
                && receipt.roles()[0].ownership() == organization::RoleMaterializationOwnership::Managed
    ));
    assert!(
        fs::read_to_string(
            team_workspace_path(&state_dir, "team-release", "reviewer").join("AGENTS.md"),
        )
        .unwrap()
        .contains("matchaclaw-teamrun:begin:team-release:reviewer")
    );
}

#[test]
fn materialization_progress_compensates_markers_and_agents_in_reverse_order() {
    let mut progress = MaterializationProgress {
        created_agents: vec![
            TeamOwnedAgentId::try_new("agent-first").unwrap(),
            TeamOwnedAgentId::try_new("agent-second").unwrap(),
        ],
        config_restore: None,
        markers: Vec::new(),
        written_markers: 0,
    };
    assert_eq!(progress.created_agents.pop().unwrap().0, "agent-second");
    assert_eq!(progress.created_agents.pop().unwrap().0, "agent-first");
}

#[tokio::test(flavor = "current_thread")]
async fn multi_role_materialization_compensates_native_mutations_in_reverse_after_marker_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let state_dir = test_state_dir();
    let failing_workspace = team_workspace_path(&state_dir, "team-release", "approver");
    fs::create_dir_all(failing_workspace.parent().unwrap()).unwrap();
    fs::write(&failing_workspace, "not a workspace directory").unwrap();
    let leader_marker = team_workspace_path(&state_dir, "team-release", "leader").join("AGENTS.md");
    let reviewer_marker =
        team_workspace_path(&state_dir, "team-release", "reviewer").join("AGENTS.md");
    let server_leader_marker = leader_marker.clone();
    let server_reviewer_marker = reviewer_marker.clone();

    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["name"], "managed-leader");
        let first_workspace = request["params"]["workspace"].as_str().unwrap().to_owned();
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "ok": true, "agentId": "managed-first", "name": "managed-leader",
                    "workspace": first_workspace.clone(), "model": null
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-first");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-first"}}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["name"], "managed-reviewer");
        let second_workspace = request["params"]["workspace"].as_str().unwrap().to_owned();
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "ok": true, "agentId": "managed-second", "name": "managed-reviewer",
                    "workspace": second_workspace.clone(), "model": null
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-second");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-second"}}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["name"], "managed-approver");
        let third_workspace = request["params"]["workspace"].as_str().unwrap().to_owned();
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "ok": true, "agentId": "managed-third", "name": "managed-approver",
                    "workspace": third_workspace.clone(), "model": null
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-third");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-third"}}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "config.get");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": materialization_config_snapshot_payload()}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let config: Value =
            serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(config.as_object().unwrap().len(), 1);
        assert_eq!(config["agents"].as_object().unwrap().len(), 1);
        assert_eq!(
            config["agents"]["list"],
            json!([
                {"id": "managed-first", "name": "managed-leader", "workspace": first_workspace.clone()},
                {"id": "managed-second", "name": "managed-reviewer", "workspace": second_workspace.clone()},
                {"id": "managed-third", "name": "managed-approver", "workspace": third_workspace.clone()}
            ])
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [
                        {"id": "managed-first", "workspace": first_workspace.clone()},
                        {"id": "managed-second", "workspace": second_workspace.clone()},
                        {"id": "managed-third", "workspace": third_workspace.clone()}
                    ]
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "config.get");
        let id = request["id"].as_str().unwrap();
        let current = json!({
            "agents": {
                "list": [
                    {"id": "managed-first", "name": "managed-leader", "workspace": first_workspace.clone()},
                    {"id": "managed-second", "name": "managed-reviewer", "workspace": second_workspace.clone()},
                    {"id": "managed-third", "name": "managed-approver", "workspace": third_workspace.clone()}
                ]
            }
        });
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": materialization_config_snapshot_payload_with_raw(
                    current.to_string(),
                    "restore-base-hash"
                )
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_restore_config_patch_request(&request, "restore-base-hash");
        let restored: Value =
            serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(restored.as_object().unwrap().len(), 1);
        assert_eq!(restored["agents"].as_object().unwrap().len(), 1);
        assert_eq!(restored["agents"]["list"], json!([]));
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}}),
        )
        .await;

        assert!(
            !fs::read_to_string(server_reviewer_marker)
                .unwrap_or_default()
                .contains("matchaclaw-teamrun:begin:team-release:reviewer")
        );
        assert!(
            !fs::read_to_string(server_leader_marker)
                .unwrap_or_default()
                .contains("matchaclaw-teamrun:begin:team-release:leader")
        );
        for expected_agent_id in ["managed-third", "managed-second", "managed-first"] {
            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], "agents.delete");
            assert_eq!(request["params"]["agentId"], expected_agent_id);
            let id = request["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": id, "ok": true,
                    "payload": {"ok": true, "agentId": expected_agent_id, "removedBindings": 0}
                }),
            )
            .await;
        }
        finish_control_exchange(&mut socket).await;
    });

    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("leader").unwrap(),
                "managed-leader",
            )
            .unwrap(),
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("reviewer").unwrap(),
                "managed-reviewer",
            )
            .unwrap(),
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("approver").unwrap(),
                "managed-approver",
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let outcome = TeamProvider::new(&client, state_dir.clone())
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("multi-role-marker-failure").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
    for role in ["leader", "reviewer"] {
        let marker = super::super::buddy::TeamBuddyMarker::new(
            TeamId::try_new("team-release").unwrap(),
            organization::RoleId::try_new(role).unwrap(),
        );
        assert!(
            !marker
                .recover(&team_workspace_path(&state_dir, "team-release", role))
                .unwrap()
        );
    }
    assert!(!failing_workspace.join("AGENTS.md").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn post_config_readback_failure_restores_matching_managed_config_entry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let workspace = request["params"]["workspace"].clone();
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({
            "type": "res", "id": id, "ok": true,
            "payload": {"ok": true, "agentId": "managed-reviewer", "name": "managed-reviewer", "workspace": workspace, "model": null}
        })).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer"}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": materialization_config_snapshot_payload()})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"defaultId": "agent-main", "mainKey": "main", "scope": "global", "agents": [], "future": true}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        let restored_from = materialization_config_snapshot_payload();
        let mut current =
            serde_json::from_str::<Value>(restored_from["raw"].as_str().unwrap()).unwrap();
        current["agents"]["list"] = json!([{
            "id": "managed-reviewer",
            "name": "managed-reviewer",
            "workspace": workspace,
        }]);
        let payload = materialization_config_snapshot_payload_with_raw(
            current.to_string(),
            "restore-base-hash",
        );
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": payload}),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_restore_config_patch_request(&request, "restore-base-hash");
        let restored: Value =
            serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(restored["agents"]["list"], json!([]));
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}})).await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "removedBindings": 0}})).await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .materialize(managed_materialization_request("post-config-readback"))
        .await;
    drop(client);
    server.await.unwrap();
    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn marker_write_failure_restores_matching_managed_config_entry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let state_dir = test_state_dir();
    let marker_workspace = team_workspace_path(&state_dir, "team-release", "reviewer");
    fs::create_dir_all(marker_workspace.parent().unwrap()).unwrap();
    fs::write(&marker_workspace, "not a workspace directory").unwrap();
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let workspace = request["params"]["workspace"].clone();
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({
            "type": "res", "id": id, "ok": true,
            "payload": {"ok": true, "agentId": "managed-reviewer", "name": "managed-reviewer", "workspace": workspace, "model": null}
        })).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer"}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": materialization_config_snapshot_payload()})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "managed-reviewer", "workspace": workspace.clone()}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        let mut current = serde_json::from_str::<Value>(
            materialization_config_snapshot_payload()["raw"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        current["agents"]["list"] = json!([{
            "id": "managed-reviewer",
            "name": "managed-reviewer",
            "workspace": workspace,
        }]);
        let payload = materialization_config_snapshot_payload_with_raw(
            current.to_string(),
            "marker-restore-base-hash",
        );
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": payload}),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_restore_config_patch_request(&request, "marker-restore-base-hash");
        let restored: Value =
            serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(restored["agents"]["list"], json!([]));
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}})).await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "removedBindings": 0}})).await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = TeamProvider::new(&client, state_dir)
        .materialize(managed_materialization_request("marker-write-failure"))
        .await;
    drop(client);
    server.await.unwrap();
    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn changed_external_config_entry_fences_restore_and_keeps_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let workspace = request["params"]["workspace"].clone();
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "name": "managed-reviewer", "workspace": workspace, "model": null}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer"}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": materialization_config_snapshot_payload()})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"defaultId": "agent-main", "mainKey": "main", "scope": "global", "agents": [], "future": true}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        let mut changed = serde_json::from_str::<Value>(
            materialization_config_snapshot_payload()["raw"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        changed["agents"]["list"] = json!([{"id": "managed-reviewer", "name": "external-name", "workspace": "external-workspace"}]);
        let payload = materialization_config_snapshot_payload_with_raw(
            changed.to_string(),
            "external-base-hash",
        );
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": payload}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "removedBindings": 0}})).await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .materialize(managed_materialization_request("external-fence"))
        .await;
    drop(client);
    server.await.unwrap();
    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn restore_unknown_still_deletes_the_managed_agent() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let workspace = request["params"]["workspace"].clone();
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "name": "managed-reviewer", "workspace": workspace, "model": null}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer"}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": materialization_config_snapshot_payload()})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_materialization_config_patch_request(&request, "base-hash-canary");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "path": "config-path-canary", "config": {}}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"defaultId": "agent-main", "mainKey": "main", "scope": "global", "agents": [], "future": true}})).await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        let mut current = serde_json::from_str::<Value>(
            materialization_config_snapshot_payload()["raw"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        current["agents"]["list"] = json!([{
            "id": "managed-reviewer",
            "name": "managed-reviewer",
            "workspace": workspace,
        }]);
        let payload = materialization_config_snapshot_payload_with_raw(
            current.to_string(),
            "unknown-restore-base-hash",
        );
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": payload}),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_restore_config_patch_request(&request, "unknown-restore-base-hash");
        socket.close(None).await.unwrap();

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        let id = request["id"].as_str().unwrap();
        send_json(&mut socket, json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "removedBindings": 0}})).await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .materialize(managed_materialization_request("restore-unknown"))
        .await;
    drop(client);
    server.await.unwrap();
    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn removal_port_never_deletes_external_receipt_agents() {
    let state_dir = test_state_dir();
    let marker = super::super::buddy::TeamBuddyMarker::new(
        TeamId::try_new("team-release").unwrap(),
        organization::RoleId::try_new("approver").unwrap(),
    );
    let marker_workspace = state_dir.as_path().join("external-approver-workspace");
    marker.write(&marker_workspace).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let external_workspace = marker_workspace.to_string_lossy().into_owned();
    let managed_workspace = team_workspace_path(&state_dir, "team-release", "reviewer")
        .to_string_lossy()
        .into_owned();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.delete");
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {"ok": true, "agentId": "managed-reviewer", "removedBindings": 0}
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let receipt = organization::MaterializationReceipt::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        vec![
            organization::RoleMaterializationReceipt::with_native_workspace(
                organization::RoleId::try_new("reviewer").unwrap(),
                organization::ManagedAgentReference::try_new("managed-reviewer").unwrap(),
                organization::RoleMaterializationOwnership::Managed,
                RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
                organization::NativeWorkspaceReceipt::try_new(managed_workspace).unwrap(),
            ),
            organization::RoleMaterializationReceipt::with_native_workspace(
                organization::RoleId::try_new("approver").unwrap(),
                organization::ManagedAgentReference::try_new("external-approver").unwrap(),
                organization::RoleMaterializationOwnership::External,
                RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
                organization::NativeWorkspaceReceipt::try_new(external_workspace).unwrap(),
            ),
        ],
    )
    .unwrap();

    let provider = TeamProvider::new(&client, state_dir.clone());
    let outcome = provider
        .remove(organization::TeamMaterializationRemoval::new(
            receipt,
            IdempotencyKey::try_new("run-42:remove:1").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { .. }
    ));
    assert!(!marker.recover(&marker_workspace).unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn external_removal_uses_receipt_workspace_without_gateway_readback() {
    let state_dir = test_state_dir();
    let workspace = state_dir.as_path().join("receipt-external-workspace");
    let marker = TeamBuddyMarker::new(
        TeamId::try_new("team-release").unwrap(),
        organization::RoleId::try_new("reviewer").unwrap(),
    );
    marker.write(&workspace).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let receipt = materialization_receipt_with_workspace(
        "reviewer",
        "external-reviewer",
        organization::RoleMaterializationOwnership::External,
        workspace.to_string_lossy().into_owned(),
    );

    let outcome = TeamProvider::new(&client, state_dir)
        .remove(organization::TeamMaterializationRemoval::new(
            receipt,
            IdempotencyKey::try_new("remove-external-only").unwrap(),
        ))
        .await;
    drop(client);

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { .. }
    ));
    assert!(!marker.recover(&workspace).unwrap());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn managed_removal_uses_receipt_workspace_for_marker_cleanup() {
    let state_dir = test_state_dir();
    let receipt_workspace = state_dir.as_path().join("receipt-managed-workspace");
    let projected_workspace = team_workspace_path(&state_dir, "team-release", "reviewer");
    let marker = TeamBuddyMarker::new(
        TeamId::try_new("team-release").unwrap(),
        organization::RoleId::try_new("reviewer").unwrap(),
    );
    marker.write(&receipt_workspace).unwrap();
    marker.write(&projected_workspace).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.delete");
        assert_eq!(
            request["params"],
            json!({"agentId": "managed-reviewer", "deleteFiles": true})
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "managed-reviewer", "removedBindings": 0}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let receipt = materialization_receipt_with_workspace(
        "reviewer",
        "managed-reviewer",
        organization::RoleMaterializationOwnership::Managed,
        receipt_workspace.to_string_lossy().into_owned(),
    );

    let outcome = TeamProvider::new(&client, state_dir)
        .remove(organization::TeamMaterializationRemoval::new(
            receipt,
            IdempotencyKey::try_new("remove-managed-receipt-workspace").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { .. }
    ));
    assert!(!marker.recover(&receipt_workspace).unwrap());
    assert!(marker.recover(&projected_workspace).unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn managed_removal_confirms_native_not_found_from_owned_receipt() {
    let state_dir = test_state_dir();
    let workspace = state_dir.as_path().join("not-found-managed-workspace");
    let marker = TeamBuddyMarker::new(
        TeamId::try_new("team-release").unwrap(),
        organization::RoleId::try_new("reviewer").unwrap(),
    );
    marker.write(&workspace).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["params"]["agentId"], "managed-reviewer");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": false, "error": {"code": "AGENT_NOT_FOUND", "message": "redacted"}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let receipt = materialization_receipt_with_workspace(
        "reviewer",
        "managed-reviewer",
        organization::RoleMaterializationOwnership::Managed,
        workspace.to_string_lossy().into_owned(),
    );

    let outcome = TeamProvider::new(&client, state_dir)
        .remove(organization::TeamMaterializationRemoval::new(
            receipt,
            IdempotencyKey::try_new("remove-managed-not-found").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { .. }
    ));
    assert!(!marker.recover(&workspace).unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn managed_removal_malformed_delete_response_remains_outcome_unknown() {
    let state_dir = test_state_dir();
    let workspace = state_dir.as_path().join("malformed-managed-workspace");
    let marker = TeamBuddyMarker::new(
        TeamId::try_new("team-release").unwrap(),
        organization::RoleId::try_new("reviewer").unwrap(),
    );
    marker.write(&workspace).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "other-agent", "removedBindings": 0}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let receipt = materialization_receipt_with_workspace(
        "reviewer",
        "managed-reviewer",
        organization::RoleMaterializationOwnership::Managed,
        workspace.to_string_lossy().into_owned(),
    );

    let outcome = TeamProvider::new(&client, state_dir)
        .remove(organization::TeamMaterializationRemoval::new(
            receipt,
            IdempotencyKey::try_new("remove-managed-malformed").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn removal_without_receipt_workspace_remains_outcome_unknown_without_gateway() {
    let state_dir = test_state_dir();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let receipt = organization::MaterializationReceipt::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        vec![organization::RoleMaterializationReceipt::with_ownership(
            organization::RoleId::try_new("reviewer").unwrap(),
            organization::ManagedAgentReference::try_new("managed-reviewer").unwrap(),
            organization::RoleMaterializationOwnership::Managed,
            RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        )],
    )
    .unwrap();

    let outcome = TeamProvider::new(&client, state_dir)
        .remove(organization::TeamMaterializationRemoval::new(
            receipt,
            IdempotencyKey::try_new("remove-missing-workspace").unwrap(),
        ))
        .await;
    drop(client);

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn manual_materialization_projects_only_gateway_confirmed_external_workspace() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let state_dir = test_state_dir();
    let workspace = state_dir.as_path().join("native-external-workspace");
    let workspace_wire = workspace.to_string_lossy().into_owned();
    let server_workspace = workspace_wire.clone();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "external-reviewer", "workspace": server_workspace.clone()}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "external-reviewer", "workspace": server_workspace}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-manual").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::Manual,
        vec![RoleAgentMaterialization::external(
            organization::RoleId::try_new("leader").unwrap(),
            organization::ManagedAgentReference::try_new("external-reviewer").unwrap(),
        )],
    )
    .unwrap();

    let outcome = TeamProvider::new(&client, state_dir.clone())
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("manual:external:1").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { ref receipt }
            if receipt.roles()[0].native_workspace().map(organization::NativeWorkspaceReceipt::as_str) == Some(workspace_wire.as_str())
    ));
    assert!(!format!("{outcome:?}").contains(workspace_wire.as_str()));
    assert!(
        fs::read_to_string(workspace.join("AGENTS.md"))
            .unwrap()
            .contains("matchaclaw-teamrun:begin:team-manual:leader")
    );
    assert!(
        !team_workspace_path(&state_dir, "team-manual", "leader")
            .join("AGENTS.md")
            .exists()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn manual_materialization_rejects_missing_or_duplicate_native_workspace_facts() {
    for agents in [
        json!([]),
        json!([{"id": "external-reviewer", "workspace": null}]),
        json!([
            {"id": "external-reviewer", "workspace": "private-workspace-one"},
            {"id": "external-reviewer", "workspace": "private-workspace-two"}
        ]),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
            let request = read_json(&mut socket).await;
            let id = request["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": id, "ok": true,
                    "payload": {
                        "defaultId": "agent-main", "mainKey": "main", "scope": "global", "agents": agents
                    }
                }),
            )
            .await;
            finish_control_exchange(&mut socket).await;
        });
        let intent = TeamMaterializationIntent::try_new(
            TeamId::try_new("team-manual").unwrap(),
            RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
            MaterializationSource::Manual,
            vec![RoleAgentMaterialization::external(
                organization::RoleId::try_new("leader").unwrap(),
                organization::ManagedAgentReference::try_new("external-reviewer").unwrap(),
            )],
        )
        .unwrap();
        let outcome = test_provider(&client)
            .materialize(TeamMaterializationRequest::new(
                intent,
                IdempotencyKey::try_new("manual:external:missing").unwrap(),
            ))
            .await;
        drop(client);
        server.await.unwrap();

        assert!(matches!(
            outcome,
            MaterializationOperationOutcome::Rejected { .. }
        ));
        assert!(!format!("{outcome:?}").contains("private-workspace"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn external_materialization_writes_only_its_own_marker() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let state_dir = test_state_dir();
    let native_workspace = state_dir.as_path().join("external-reviewer-workspace");
    let server_workspace = native_workspace.to_string_lossy().into_owned();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "external-reviewer", "workspace": server_workspace.clone()}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;

        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.list");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "external-reviewer", "workspace": server_workspace}]
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![RoleAgentMaterialization::external(
            organization::RoleId::try_new("reviewer").unwrap(),
            organization::ManagedAgentReference::try_new("external-reviewer").unwrap(),
        )],
    )
    .unwrap();
    let provider = TeamProvider::new(&client, state_dir.clone());

    let outcome = provider
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("run-42:reviewer:external-marker").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::Confirmed { ref receipt }
            if receipt.roles().len() == 1
                && receipt.roles()[0].agent().as_str() == "external-reviewer"
                && receipt.roles()[0].ownership() == organization::RoleMaterializationOwnership::External
    ));
    assert!(
        fs::read_to_string(native_workspace.join("AGENTS.md"))
            .unwrap()
            .contains("matchaclaw-teamrun:begin:team-release:reviewer")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn create_accepts_only_matching_success_and_redacts_workspace_input() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.create");
        assert_eq!(
            request["params"],
            json!({"name": "team-agent", "workspace": "private-workspace-canary"})
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "ok": true, "agentId": "team-agent", "name": "team-agent",
                    "workspace": "private-workspace-canary", "model": null
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });
    let input = TeamAgentCreate::try_new(
        "team-agent",
        ResolvedWorkspace::try_new("private-workspace-canary").unwrap(),
    )
    .unwrap();
    assert!(!format!("{input:?}").contains("private-workspace-canary"));

    let outcome = test_provider(&client).create_agent(input).await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, MutationOutcome::Applied(_)));
}

#[tokio::test(flavor = "current_thread")]
async fn create_requires_native_echo_of_the_requested_name_and_workspace() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        for response in [
            json!({
                "ok": true, "agentId": "team-agent", "name": "other-agent",
                "workspace": "private-workspace-canary", "model": null
            }),
            json!({
                "ok": true, "agentId": "team-agent", "name": "team-agent",
                "workspace": "other-workspace", "model": null
            }),
        ] {
            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], "agents.create");
            let id = request["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({"type": "res", "id": id, "ok": true, "payload": response}),
            )
            .await;
        }
        finish_control_exchange(&mut socket).await;
    });

    let provider = test_provider(&client);
    for _ in 0..2 {
        let outcome = provider
            .create_agent(
                TeamAgentCreate::try_new(
                    "team-agent",
                    ResolvedWorkspace::try_new("private-workspace-canary").unwrap(),
                )
                .unwrap(),
            )
            .await;
        assert!(
            matches!(outcome, MutationOutcome::OutcomeUnknown),
            "{outcome:?}"
        );
    }
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn malformed_create_response_remains_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.create");
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "error": {}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .create_agent(
            TeamAgentCreate::try_new(
                "team-agent",
                ResolvedWorkspace::try_new("private-workspace-canary").unwrap(),
            )
            .unwrap(),
        )
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, MutationOutcome::OutcomeUnknown));
}

#[tokio::test(flavor = "current_thread")]
async fn update_and_delete_issue_exact_scoped_requests_and_require_confirmed_identities() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.update");
        assert_eq!(
            request["params"],
            json!({
                "agentId": "team-agent", "name": "team-agent-renamed",
                "workspace": "private-workspace-canary", "model": "provider/model"
            })
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "payload": {"ok": true, "agentId": "team-agent"}}),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.delete");
        assert_eq!(
            request["params"],
            json!({"agentId": "team-agent", "deleteFiles": true})
        );
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {"ok": true, "agentId": "team-agent", "removedBindings": 0}
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let provider = test_provider(&client);
    let update = TeamAgentUpdate::try_new(
        TeamOwnedAgentId::try_new("team-agent").unwrap(),
        "team-agent-renamed",
        ResolvedWorkspace::try_new("private-workspace-canary").unwrap(),
        Some("provider/model".into()),
    )
    .unwrap();
    assert!(matches!(
        provider.update_agent(update).await,
        MutationOutcome::Applied(())
    ));
    assert!(matches!(
        provider
            .delete_agent(TeamOwnedAgentId::try_new("team-agent").unwrap())
            .await,
        MutationOutcome::Applied(())
    ));
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn local_pre_write_failure_is_rejected_without_a_team_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    client.close_control_connection().await;
    let encoded = wire::team::agents_delete_request("local-failure".into(), "team-agent".into())
        .unwrap()
        .encode()
        .unwrap();

    let outcome = test_provider(&client)
        .write_encoded(
            encoded,
            "local-failure".into(),
            "agents.delete",
            wire::team::decode_agents_delete,
        )
        .await;

    assert!(matches!(outcome, MutationOutcome::Rejected));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn closed_write_connection_remains_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let _ = read_json(&mut socket).await;
        socket.close(None).await.unwrap();
    });

    let outcome = test_provider(&client)
        .delete_agent(TeamOwnedAgentId::try_new("team-agent").unwrap())
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, MutationOutcome::OutcomeUnknown));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_create_uncertainty_does_not_retry_or_list_guess() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.create");
        socket.close(None).await.unwrap();
    });
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-uncertain").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("reviewer").unwrap(),
                "managed-reviewer",
            )
            .unwrap(),
        ],
    )
    .unwrap();

    let outcome = test_provider(&client)
        .materialize(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new("run-42:reviewer:uncertain").unwrap(),
        ))
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(
        outcome,
        MaterializationOperationOutcome::OutcomeUnknown
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn timeout_after_write_remains_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "agents.delete");
        tokio::time::sleep(Duration::from_millis(20)).await;
        finish_control_exchange(&mut socket).await;
    });

    let request = wire::team::agents_delete_request("timeout-canary".into(), "team-agent".into())
        .unwrap()
        .encode()
        .unwrap();
    let outcome = test_provider(&client)
        .write_encoded_with_test_deadline(
            request,
            "timeout-canary".into(),
            "agents.delete",
            Duration::from_millis(1),
            wire::team::decode_agents_delete,
        )
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, MutationOutcome::OutcomeUnknown));
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_correlated_write_response_remains_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({"type": "res", "id": id, "ok": true, "error": {}}),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .delete_agent(TeamOwnedAgentId::try_new("team-agent").unwrap())
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, MutationOutcome::OutcomeUnknown));
}

#[tokio::test(flavor = "current_thread")]
async fn recover_rejects_malformed_native_facts_without_private_leaks() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {
                    "defaultId": "agent-main", "mainKey": "main", "scope": "global",
                    "agents": [{"id": 42, "workspace": "private-workspace-canary"}],
                    "unexpected": "private-native-detail-canary"
                }
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .recover(
            TeamRecoveryRequest::try_new(
                "team-release",
                vec![TeamRecoveryRole::try_new("lead", "agent-lead").unwrap()],
            )
            .unwrap(),
        )
        .await;
    drop(client);
    server.await.unwrap();

    let Err(error) = outcome else {
        panic!("malformed native facts must not recover");
    };
    for canary in [
        "agent-lead",
        "private-workspace-canary",
        "private-native-detail-canary",
    ] {
        assert!(!format!("{error:?}").contains(canary));
    }
    assert!(matches!(error, ReadFailure::Protocol));
}

#[tokio::test(flavor = "current_thread")]
async fn malformed_read_schema_is_protocol_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_READ_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": true,
                "payload": {"defaultId": "agent-main", "mainKey": "main", "scope": "global", "agents": "not-a-list"}
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client).list_agents().await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, Err(ReadFailure::Protocol)));
}

#[tokio::test(flavor = "current_thread")]
async fn explicit_gateway_write_failure_is_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, wire::GATEWAY_TEAM_WRITE_SCOPE).await;
        let request = read_json(&mut socket).await;
        let id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": id, "ok": false,
                "error": {"code": "DENIED", "message": "private-denial-canary"}
            }),
        )
        .await;
        finish_control_exchange(&mut socket).await;
    });

    let outcome = test_provider(&client)
        .delete_agent(TeamOwnedAgentId::try_new("team-agent").unwrap())
        .await;
    drop(client);
    server.await.unwrap();

    assert!(matches!(outcome, MutationOutcome::Rejected));
}

#[test]
fn debug_redacts_workspace_raw_config_and_agent_ids() {
    let workspace = ResolvedWorkspace::try_new("private-workspace-canary").unwrap();
    let create = TeamAgentCreate::try_new("team-agent-canary", workspace).unwrap();
    let update = TeamAgentUpdate::try_new(
        TeamOwnedAgentId::try_new("team-agent-canary").unwrap(),
        "team-agent-renamed-canary",
        ResolvedWorkspace::try_new("private-workspace-canary").unwrap(),
        Some("provider/model-canary".into()),
    )
    .unwrap();
    let agent = TeamAgent::new("team-agent-canary".into(), None);
    let owned_id = TeamOwnedAgentId::try_new("team-agent-canary").unwrap();
    let outcome = MutationOutcome::Applied(TeamOwnedAgentId::try_new("team-agent-canary").unwrap());

    assert_debug_redacts(&create, &["team-agent-canary", "private-workspace-canary"]);
    assert_debug_redacts(
        &update,
        &[
            "team-agent-canary",
            "team-agent-renamed-canary",
            "private-workspace-canary",
            "provider/model-canary",
        ],
    );
    assert_debug_redacts(agent.id(), &["team-agent-canary"]);
    assert_debug_redacts(&owned_id, &["team-agent-canary"]);
    assert_debug_redacts(&outcome, &["team-agent-canary"]);
    assert_not_debug::<TeamConfigSnapshot, _>();
}

fn test_provider(client: &GatewayClient) -> TeamProvider {
    TeamProvider::new(client, test_state_dir())
}

fn test_state_dir() -> CanonicalStateDir {
    static NEXT_STATE_DIR: AtomicU64 = AtomicU64::new(1);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "matchaclaw-team-state-{}-{nanos}",
        NEXT_STATE_DIR.fetch_add(1, Ordering::Relaxed),
    ));
    let state_dir = CanonicalStateDir::provision(path).expect("provision test state directory");
    fs::write(state_dir.as_path().join("openclaw.json"), "{}").expect("write canonical config");
    state_dir
}

fn team_workspace_path(
    state_dir: &CanonicalStateDir,
    team: &str,
    role: &str,
) -> std::path::PathBuf {
    state_dir
        .as_path()
        .join("teambuddy")
        .join(stable_workspace_segment("team", team))
        .join(stable_workspace_segment("role", role))
}

fn stable_workspace_segment(prefix: &str, value: &str) -> String {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let hash = value.as_bytes().iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    });
    format!("{prefix}-{hash:016x}")
}

fn test_client(
    listener: &TcpListener,
    certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
) -> GatewayClient {
    GatewayClient::new(
        GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
        certificate_fingerprint,
        Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
        GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
    )
}

fn assert_debug_redacts(value: &impl Debug, canaries: &[&str]) {
    let debug = format!("{value:?}");
    for canary in canaries {
        assert!(!debug.contains(canary));
    }
}

trait AmbiguousIfDebug<A> {}
impl<T> AmbiguousIfDebug<()> for T {}
impl<T: Debug> AmbiguousIfDebug<u8> for T {}
fn assert_not_debug<T: AmbiguousIfDebug<A>, A>() {}

#[test]
fn team_buddy_marker_is_opaque_idempotent_and_recovers_only_its_own_block() {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    use organization::{RoleId, TeamId};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);
    let directory = std::env::temp_dir().join(format!(
        "matchaclaw-team-buddy-marker-{}",
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&directory).unwrap();
    let agents = directory.join("AGENTS.md");
    fs::write(
        &agents,
        "# Existing instructions\n\n<!-- another-team-marker -->\n",
    )
    .unwrap();

    let marker = super::super::buddy::TeamBuddyMarker::new(
        TeamId::try_new("team-release").unwrap(),
        RoleId::try_new("reviewer").unwrap(),
    );
    assert!(!format!("{marker:?}").contains("team-release"));
    assert!(!format!("{marker:?}").contains("reviewer"));

    marker.write(&directory).unwrap();
    marker.write(&directory).unwrap();
    assert!(marker.recover(&directory).unwrap());
    let materialized = fs::read_to_string(&agents).unwrap();
    assert_eq!(materialized.matches("matchaclaw-teamrun:begin:").count(), 1);
    assert!(materialized.contains("<!-- another-team-marker -->"));

    marker.remove(&directory).unwrap();
    assert!(!marker.recover(&directory).unwrap());
    assert!(
        fs::read_to_string(&agents)
            .unwrap()
            .contains("<!-- another-team-marker -->")
    );
    fs::remove_dir_all(directory).unwrap();
}

fn managed_materialization_request(idempotency_key: &str) -> TeamMaterializationRequest {
    let intent = TeamMaterializationIntent::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        MaterializationSource::TeamSkill,
        vec![
            RoleAgentMaterialization::managed(
                organization::RoleId::try_new("reviewer").unwrap(),
                "managed-reviewer",
            )
            .unwrap(),
        ],
    )
    .unwrap();
    TeamMaterializationRequest::new(intent, IdempotencyKey::try_new(idempotency_key).unwrap())
}

fn materialization_receipt_with_workspace(
    role: &str,
    agent: &str,
    ownership: organization::RoleMaterializationOwnership,
    workspace: String,
) -> organization::MaterializationReceipt {
    organization::MaterializationReceipt::try_new(
        TeamId::try_new("team-release").unwrap(),
        RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
        vec![
            organization::RoleMaterializationReceipt::with_native_workspace(
                organization::RoleId::try_new(role).unwrap(),
                organization::ManagedAgentReference::try_new(agent).unwrap(),
                ownership,
                RuntimeEndpointReference::try_new("endpoint-primary").unwrap(),
                organization::NativeWorkspaceReceipt::try_new(workspace).unwrap(),
            ),
        ],
    )
    .unwrap()
}

fn materialization_config_snapshot_payload_with_raw(raw: String, hash: &str) -> Value {
    json!({
        "path": "config-path-canary",
        "exists": true,
        "raw": raw,
        "parsed": {},
        "sourceConfig": {},
        "resolved": {},
        "valid": true,
        "runtimeConfig": {},
        "config": {},
        "hash": hash,
        "issues": [],
        "warnings": [],
        "legacyIssues": []
    })
}

fn materialization_config_snapshot_payload() -> Value {
    materialization_config_snapshot_payload_with_raw(
        "{\"agents\":{\"list\":[]}}".into(),
        "base-hash-canary",
    )
}

fn assert_team_request(request: &Value, method: &str) {
    assert_eq!(request["type"], "req");
    assert_eq!(request["method"], method);
    assert_ne!(request["method"], "sessions.subscribe");
}

fn assert_materialization_config_patch_request(request: &Value, base_hash: &str) {
    assert_team_request(request, "config.patch");
    assert_eq!(request["params"]["baseHash"], base_hash);
    assert!(request["params"].get("replacePaths").is_none());
    let raw: Value = serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
    assert_eq!(raw.as_object().unwrap().len(), 1);
    assert_eq!(raw["agents"].as_object().unwrap().len(), 1);
    assert!(raw["agents"]["list"].is_array());
}

fn assert_restore_config_patch_request(request: &Value, base_hash: &str) {
    assert_team_request(request, "config.patch");
    assert_eq!(request["params"]["baseHash"], base_hash);
    assert_eq!(request["params"]["replacePaths"], json!(["agents.list"]));
    let raw: Value = serde_json::from_str(request["params"]["raw"].as_str().unwrap()).unwrap();
    assert_eq!(raw.as_object().unwrap().len(), 1);
    assert_eq!(raw["agents"].as_object().unwrap().len(), 1);
    assert!(raw["agents"]["list"].is_array());
}

async fn serve_hello(socket: &mut TestSocket, required_scope: &str) {
    const CONTROL_SCOPES: [&str; 4] = [
        wire::GATEWAY_TEAM_READ_SCOPE,
        wire::GATEWAY_TEAM_WRITE_SCOPE,
        "operator.admin",
        "operator.approvals",
    ];
    const CONTROL_METHODS: [&str; 10] = [
        "status",
        "config.get",
        "config.patch",
        "config.apply",
        "plugins.refresh",
        "agents.list",
        "skills.status",
        "channels.pairing.list",
        "sessions.describe",
        wire::SYSTEM_PRESENCE_METHOD,
    ];

    assert!(CONTROL_SCOPES.contains(&required_scope));
    send_json(
        socket,
        json!({
            "type": "event", "event": "connect.challenge",
            "payload": {"nonce": "fake-nonce", "ts": 42}
        }),
    )
    .await;
    let connect = read_json(socket).await;
    assert_eq!(connect["method"], "connect");
    assert_eq!(connect["params"]["scopes"], json!(CONTROL_SCOPES));
    let id = connect["id"].as_str().unwrap();
    send_json(
        socket,
        json!({
            "type": "res", "id": id, "ok": true,
            "payload": {
                "type": "hello-ok", "protocol": 4,
                "server": {"version": "2026.5.20", "connId": "fake-connection"},
                "features": {"methods": CONTROL_METHODS, "events": ["tick"], "capabilities": ["agent-kind", "tool-events"]},
                "snapshot": {
                    "presence": [{"ts": 41}], "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 100
                },
                "auth": {"role": "operator", "scopes": CONTROL_SCOPES},
                "policy": {
                    "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                    "tickIntervalMs": 15000
                }
            }
        }),
    )
    .await;
}

async fn finish_control_exchange(socket: &mut TestSocket) {
    socket.close(None).await.unwrap();
}

async fn read_json(socket: &mut TestSocket) -> Value {
    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
        panic!("expected text frame");
    };
    serde_json::from_str(text.as_str()).unwrap()
}

async fn send_json(socket: &mut TestSocket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("test websocket send must succeed");
}
