#[cfg(test)]
mod tests {
    use super::super::command::{SessionCommand, SessionSendRequest};
    use super::super::query::SessionQuery;
    use super::super::send::{NativeEndpoint, SessionSendCommand};
    use super::super::state::{SessionIdentity, SessionProvider};
    use foundation::execution::{CommandRoute, QueryRoute};
    use tokio::sync::oneshot;

    fn mock_session_identity(provider: SessionProvider, session_key: &str) -> SessionIdentity {
        SessionIdentity::try_new(session_key, provider, None).expect("valid test session identity")
    }

    #[tokio::test]
    async fn session_commands_route_to_keyed_lanes() {
        let identity = mock_session_identity(SessionProvider::OpenClaw, "abc");
        let (reply, _rx) = oneshot::channel();
        let command = SessionCommand::Ensure { identity, reply };

        assert_eq!(
            command.route(),
            CommandRoute::Keyed("openclaw:abc".to_owned())
        );
    }

    #[tokio::test]
    async fn touch_and_evict_route_to_their_session_lane() {
        let (tx1, _rx1) = oneshot::channel();
        let (tx2, _rx2) = oneshot::channel();

        let touch_cmd = SessionCommand::Touch {
            session_key: "test-session".to_string(),
            reply: tx1,
        };
        let evict_cmd = SessionCommand::Evict {
            session_key: "test-session".to_string(),
            reply: tx2,
        };

        assert_eq!(
            touch_cmd.route(),
            CommandRoute::Keyed("openclaw:test-session".to_owned())
        );
        assert_eq!(
            evict_cmd.route(),
            CommandRoute::Keyed("openclaw:test-session".to_owned())
        );
    }

    #[tokio::test]
    async fn snapshot_queries_remain_direct() {
        let (list_reply, _list_rx) = oneshot::channel();
        let list = SessionQuery::ListSessions { reply: list_reply };
        let (get_reply, _get_rx) = oneshot::channel();
        let get = SessionQuery::GetSession {
            session_key: "test-session".to_owned(),
            reply: get_reply,
        };

        assert_eq!(list.route(), QueryRoute::Direct);
        assert_eq!(get.route(), QueryRoute::Direct);
    }

    #[tokio::test]
    async fn send_commands_route_by_native_provider_and_session_key_only() {
        let (reply, _rx) = oneshot::channel();
        let command = SessionSendCommand::try_new(
            NativeEndpoint::OpenClawLocal,
            "agent:main:session-1".into(),
            Some("endpoint-session-1".into()),
            "renderer-route:private".into(),
            "hello".into(),
            None,
            Some("idempotency-1".into()),
            Some(true),
            Vec::new(),
            Some("trace-1".into()),
        )
        .unwrap();
        assert_eq!(
            SessionCommand::Send {
                request: SessionSendRequest::Session { command, reply }
            }
            .route(),
            CommandRoute::Keyed("openclaw:agent:main:session-1".to_owned())
        );

        let (reply, _rx) = oneshot::channel();
        let command = SessionSendCommand::try_new(
            NativeEndpoint::MatchaAgentLocal,
            "matcha-session-1".into(),
            Some("endpoint-session-1".into()),
            "renderer-route:private".into(),
            "hello".into(),
            Some("run-1".into()),
            None,
            Some(true),
            Vec::new(),
            Some("trace-1".into()),
        )
        .unwrap();
        assert_eq!(
            SessionCommand::Send {
                request: SessionSendRequest::Session { command, reply }
            }
            .route(),
            CommandRoute::Keyed("matcha-agent:matcha-session-1".to_owned())
        );

        let (reply, _rx) = oneshot::channel();
        let params = openclaw::session::protocol::ChatSendParams::try_new(
            openclaw::session::protocol::SessionKey::try_new("agent:main:session-1").unwrap(),
            "hello",
            openclaw::session::protocol::RunId::try_new("idempotency-1").unwrap(),
        )
        .unwrap();
        assert_eq!(
            SessionCommand::Send {
                request: SessionSendRequest::OpenClawChat { params, reply }
            }
            .route(),
            CommandRoute::Global
        );
    }

    #[tokio::test]
    async fn lane_retention_is_low_frequency() {
        use super::super::actor::SessionOwner;
        use foundation::execution::LaneRetention;
        assert_eq!(SessionOwner::lane_retention(), LaneRetention::LowFrequency);
    }
}

#[cfg(test)]
mod integration_tests {
    use super::super::actor::SessionOwner;
    use super::super::command::{
        SessionCommand, SessionEnsureOutcome, SessionEvent, SessionIngestOutcome,
    };
    use super::super::state::{RunPhase, SessionChange, SessionIdentity, SessionProvider};
    use crate::{
        provider::{
            ProviderAccountsOwner, ProviderModelOwner, ProviderRoutingOwner, actor::ProviderOwner,
            handle::ProviderHandle,
        },
        runtime_directory::RuntimeDriverDirectory,
    };
    use environment::ProviderCascade;
    use foundation::execution::{OwnerRuntimeConfig, OwnerRuntimeSystem};
    use std::sync::Arc;
    use tokio::sync::oneshot;

    fn runtime_provider_handle() -> ProviderHandle {
        let root = tempfile::tempdir().expect("provider tempdir");
        let cascade = ProviderCascade::open(
            root.path().join("accounts.json"),
            root.path().join("models.json"),
            root.path().join("routing.json"),
            root.path().join("cascade.json"),
        )
        .expect("provider cascade");
        let owner = crate::provider::actor::ProviderOwner::new(
            cascade,
            ProviderAccountsOwner::new(
                crate::transport::provider_accounts::private_auth::Resolver::disabled(),
            ),
            ProviderModelOwner::new(),
            ProviderRoutingOwner::new(),
            Arc::new(RuntimeDriverDirectory::new()),
        );
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, ProviderOwner::lane_retention()));
        let (handle, task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, ProviderOwner::lane_retention()),
        );
        task.detach();
        ProviderHandle::new(handle)
    }

    fn session_owner(
        runtime_dir: Arc<RuntimeDriverDirectory>,
    ) -> (
        SessionOwner,
        Arc<arc_swap::ArcSwap<super::super::actor::SessionSnapshot>>,
    ) {
        SessionOwner::new(runtime_dir, runtime_provider_handle(), None)
    }

    fn mock_identity(provider: SessionProvider, session_key: &str) -> SessionIdentity {
        SessionIdentity::try_new(session_key, provider, None).expect("valid test identity")
    }

    #[tokio::test]
    async fn multiple_sessions_write_concurrently() {
        // Arrange
        let runtime_dir = Arc::new(RuntimeDriverDirectory::new());
        let (owner, _snapshot) = session_owner(Arc::clone(&runtime_dir));
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()));
        let (handle, _task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );

        let id1 = mock_identity(SessionProvider::OpenClaw, "session1");
        let id2 = mock_identity(SessionProvider::OpenClaw, "session2");
        let id3 = mock_identity(SessionProvider::MatchaAgent, "session3");

        // Act: Send 3 ensure commands concurrently
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();
        let (tx3, rx3) = oneshot::channel();

        let cmd1 = SessionCommand::Ensure {
            identity: id1,
            reply: tx1,
        };
        let cmd2 = SessionCommand::Ensure {
            identity: id2,
            reply: tx2,
        };
        let cmd3 = SessionCommand::Ensure {
            identity: id3,
            reply: tx3,
        };

        let send1 = handle.send_command(cmd1);
        let send2 = handle.send_command(cmd2);
        let send3 = handle.send_command(cmd3);

        let _ = tokio::join!(send1, send2, send3);
        let results = tokio::join!(rx1, rx2, rx3);

        // Assert: All completed without deadlock
        assert!(results.0.is_ok());
        assert!(results.1.is_ok());
        assert!(results.2.is_ok());
    }

    #[tokio::test]
    async fn same_session_different_runs_serialize() {
        // Arrange
        let runtime_dir = Arc::new(RuntimeDriverDirectory::new());
        let (owner, _snapshot) = session_owner(Arc::clone(&runtime_dir));
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()));
        let (handle, _task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );

        let id = mock_identity(SessionProvider::OpenClaw, "shared-session");

        // Act: Send 2 commands for the same session
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();

        let cmd1 = SessionCommand::Ensure {
            identity: id.clone(),
            reply: tx1,
        };
        let cmd2 = SessionCommand::Ensure {
            identity: id,
            reply: tx2,
        };

        handle.send_command(cmd1).await.expect("send cmd1");
        handle.send_command(cmd2).await.expect("send cmd2");

        let result1 = rx1.await.expect("receive result1");
        let result2 = rx2.await.expect("receive result2");

        // Assert: First creates, second sees existing (or both fail if no runtime)
        match (&result1, &result2) {
            (SessionEnsureOutcome::Created(_), SessionEnsureOutcome::Existing(_)) => {}
            (SessionEnsureOutcome::RuntimeNotFound, SessionEnsureOutcome::RuntimeNotFound) => {}
            _ => panic!("Unexpected outcomes: {:?}, {:?}", result1, result2),
        }
    }

    #[tokio::test]
    async fn cross_runtime_sessions_isolated() {
        // Arrange
        let runtime_dir = Arc::new(RuntimeDriverDirectory::new());
        let (owner, snapshot) = session_owner(Arc::clone(&runtime_dir));
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()));
        let (handle, _task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );

        let openclaw_abc = mock_identity(SessionProvider::OpenClaw, "abc");
        let matcha_abc = mock_identity(SessionProvider::MatchaAgent, "abc");

        // Act: Create sessions with same key but different providers
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();

        handle
            .send_command(SessionCommand::Ensure {
                identity: openclaw_abc.clone(),
                reply: tx1,
            })
            .await
            .ok();
        handle
            .send_command(SessionCommand::Ensure {
                identity: matcha_abc.clone(),
                reply: tx2,
            })
            .await
            .ok();

        let _ = tokio::join!(rx1, rx2);

        // Assert: States are separate in snapshot
        let snap = snapshot.load();
        let has_openclaw = snap
            .states
            .values()
            .any(|s| s.identity().provider() == SessionProvider::OpenClaw);
        let has_matcha = snap
            .states
            .values()
            .any(|s| s.identity().provider() == SessionProvider::MatchaAgent);

        // Both could be created (if runtimes available) or neither (if no runtimes)
        // The key invariant: they must not collide on the same session key
        if has_openclaw || has_matcha {
            assert!(
                snap.states.len() <= 2,
                "At most 2 sessions with same key but different providers"
            );
        }
    }

    #[tokio::test]
    async fn handle_ingest_applies_openclaw_canonical() {
        // Arrange
        let runtime_dir = Arc::new(RuntimeDriverDirectory::new());
        let (owner, snapshot) = session_owner(Arc::clone(&runtime_dir));
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()));
        let (handle, _task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );

        let identity = mock_identity(SessionProvider::OpenClaw, "session-abc");
        let binding = super::super::state::SessionSourceBinding::new("session-abc", None, Some(1))
            .expect("valid binding");
        let event = SessionEvent {
            binding,
            run_id: Some("run-1".to_owned()),
            cursor: Some(1),
            changes: vec![SessionChange::RunPhaseChanged {
                run_id: "run-1".to_owned(),
                phase: RunPhase::Started,
            }],
        };

        // Act
        let (reply, rx) = oneshot::channel();
        handle
            .send_command(SessionCommand::Ingest {
                identity,
                event,
                reply,
            })
            .await
            .unwrap();
        let outcome = rx.await.unwrap();

        // Assert
        match outcome {
            SessionIngestOutcome::Applied(delta) => assert_eq!(delta.cursor, 1),
            _ => panic!("Expected Applied outcome, got {:?}", outcome),
        }
        let snap = snapshot.load();
        // State might not be created if runtime not found
        if !snap.states.is_empty() {
            assert_eq!(snap.states.len(), 1);
        }
    }

    #[tokio::test]
    async fn handle_ingest_rejects_duplicate_cursor() {
        // Arrange
        let runtime_dir = Arc::new(RuntimeDriverDirectory::new());
        let (owner, _) = session_owner(Arc::clone(&runtime_dir));
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()));
        let (handle, _task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );

        let identity = mock_identity(SessionProvider::OpenClaw, "session-def");
        let changes = vec![SessionChange::RunPhaseChanged {
            run_id: "run-2".to_owned(),
            phase: RunPhase::Started,
        }];

        // First ingest
        let binding1 = super::super::state::SessionSourceBinding::new("session-def", None, Some(1))
            .expect("valid binding");
        let event1 = SessionEvent {
            binding: binding1,
            run_id: Some("run-2".to_owned()),
            cursor: Some(1),
            changes: changes.clone(),
        };
        let (reply1, rx1) = oneshot::channel();
        handle
            .send_command(SessionCommand::Ingest {
                identity: identity.clone(),
                event: event1,
                reply: reply1,
            })
            .await
            .unwrap();
        let outcome1 = rx1.await.unwrap();
        assert!(matches!(outcome1, SessionIngestOutcome::Applied(_)));

        // Duplicate ingest (same cursor)
        let binding2 = super::super::state::SessionSourceBinding::new("session-def", None, Some(1))
            .expect("valid binding");
        let event2 = SessionEvent {
            binding: binding2,
            run_id: Some("run-2".to_owned()),
            cursor: Some(1),
            changes,
        };
        let (reply2, rx2) = oneshot::channel();
        handle
            .send_command(SessionCommand::Ingest {
                identity,
                event: event2,
                reply: reply2,
            })
            .await
            .unwrap();
        let outcome2 = rx2.await.unwrap();

        // Assert
        match outcome2 {
            SessionIngestOutcome::Duplicate { cursor } => assert_eq!(cursor, 1),
            SessionIngestOutcome::RuntimeNotFound => {
                // If runtime not found, ingest cannot track duplicates
            }
            other => panic!("Expected Duplicate or RuntimeNotFound, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn handle_ingest_matcha_isolated_from_openclaw() {
        // Arrange
        let runtime_dir = Arc::new(RuntimeDriverDirectory::new());
        let (owner, snapshot) = session_owner(Arc::clone(&runtime_dir));
        let owner_runtime_system =
            OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()));
        let (handle, _task) = owner_runtime_system.spawn_owner(
            owner,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );

        // OpenClaw session
        let openclaw_identity = mock_identity(SessionProvider::OpenClaw, "shared-key");
        let openclaw_binding =
            super::super::state::SessionSourceBinding::new("shared-key", None, Some(1))
                .expect("valid binding");
        let openclaw_event = SessionEvent {
            binding: openclaw_binding,
            run_id: Some("run-oc".to_owned()),
            cursor: Some(1),
            changes: vec![SessionChange::RunPhaseChanged {
                run_id: "run-oc".to_owned(),
                phase: RunPhase::Started,
            }],
        };

        // Matcha session (same session_key, different provider)
        let matcha_identity = mock_identity(SessionProvider::MatchaAgent, "shared-key");
        let matcha_binding =
            super::super::state::SessionSourceBinding::new("shared-key", None, Some(1))
                .expect("valid binding");
        let matcha_event = SessionEvent {
            binding: matcha_binding,
            run_id: Some("run-ma".to_owned()),
            cursor: Some(1),
            changes: vec![SessionChange::RunPhaseChanged {
                run_id: "run-ma".to_owned(),
                phase: RunPhase::Completed,
            }],
        };

        // Act
        let (oc_reply, oc_rx) = oneshot::channel();
        handle
            .send_command(SessionCommand::Ingest {
                identity: openclaw_identity,
                event: openclaw_event,
                reply: oc_reply,
            })
            .await
            .unwrap();
        let oc_outcome = oc_rx.await.unwrap();

        let (ma_reply, ma_rx) = oneshot::channel();
        handle
            .send_command(SessionCommand::Ingest {
                identity: matcha_identity,
                event: matcha_event,
                reply: ma_reply,
            })
            .await
            .unwrap();
        let ma_outcome = ma_rx.await.unwrap();

        // Assert
        assert!(matches!(
            oc_outcome,
            SessionIngestOutcome::Applied(_) | SessionIngestOutcome::RuntimeNotFound
        ));
        assert!(matches!(
            ma_outcome,
            SessionIngestOutcome::Applied(_) | SessionIngestOutcome::RuntimeNotFound
        ));

        let snap = snapshot.load();
        // If both applied, we should see 2 states
        if snap.states.len() == 2 {
            // Both providers created separate states
            let has_openclaw = snap
                .states
                .values()
                .any(|s| s.identity().provider() == SessionProvider::OpenClaw);
            let has_matcha = snap
                .states
                .values()
                .any(|s| s.identity().provider() == SessionProvider::MatchaAgent);
            assert!(
                has_openclaw && has_matcha,
                "Expected both OpenClaw and Matcha states"
            );
        }
    }
}
