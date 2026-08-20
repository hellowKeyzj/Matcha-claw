use organization::{
    CommandPayload, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, IdempotencyKey,
    NodeDefinition, NodeId, RoleChatAdmission, RoleChatAdmissionOutcome, RoleId, RunCommand,
    RuntimeEndpointReference, StoreFault, TeamId, TeamRevision, TeamRunQueryOutcome,
    TriggerFireRequest, TriggerSource, package::TeamSkillSelectionId, run::event::OpaqueId,
};

use super::*;

#[tokio::test]
async fn closed_command_channel_rejects_lifecycle_commands() {
    let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    drop(receiver);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };

    assert!(matches!(
        handle.stop_open_claw().await,
        Err(Error::CommandChannelClosed)
    ));
    assert!(matches!(
        handle.restart_open_claw().await,
        Err(Error::CommandChannelClosed)
    ));
}

#[tokio::test]
async fn diagnostics_collection_uses_the_typed_actor_command() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let receipt = DiagnosticsArchiveReceipt::failed();
    let request = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .collect_diagnostics(DiagnosticsArchiveCancellation::new())
                .await
        }
    });

    let Some(Command::Diagnostics(DiagnosticsCommand::Submit { reply, .. })) =
        receiver.recv().await
    else {
        panic!("Host owner must submit the fixed diagnostics collection command");
    };
    reply
        .send(Ok(receipt.clone()))
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(Ok(actual)) if actual == receipt
    ));
}

#[test]
fn diagnostics_actor_dto_remains_private_to_the_host_owner() {
    let wire = include_str!("../control/wire.rs");

    for private in [
        "DiagnosticsCommand",
        "DiagnosticsArchiveCancellation",
        "DiagnosticsArchiveReceipt",
        "DiagnosticsArchiveRoot",
        "host.diagnostics.cancel",
    ] {
        assert!(!wire.contains(private));
    }
}

#[test]
fn uv_install_actor_dto_is_absent_from_private_control_wire() {
    let wire = include_str!("../control/wire.rs");

    assert!(!wire.contains("UvPython312"));
    assert!(!wire.contains("EnvironmentCommand"));
}

#[tokio::test]
async fn channel_delete_config_uses_the_typed_actor_command() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let request = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .delete_channel_config("whatsapp".into(), "primary".into())
                .await
        }
    });

    let Some(Command::Runtime(RuntimeCommand::ChannelDeleteConfig {
        channel,
        account_id,
        reply,
    })) = receiver.recv().await
    else {
        panic!("Host owner must submit the fixed channel config delete command");
    };
    assert_eq!(channel, "whatsapp");
    assert_eq!(account_id, "primary");
    reply
        .send(crate::channel_delete::Outcome::Unknown)
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(crate::channel_delete::Outcome::Unknown)
    ));
}

#[tokio::test]
async fn channel_pairing_list_preserves_the_optional_account_scope() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let request = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .list_open_claw_channel_pairing("discord".into(), Some("primary".into()))
                .await
        }
    });

    let Some(Command::Runtime(RuntimeCommand::ChannelPairing {
        channel,
        account,
        reply,
    })) = receiver.recv().await
    else {
        panic!("Host owner must submit the scoped channel pairing command");
    };
    assert_eq!(channel, "discord");
    assert_eq!(account.as_deref(), Some("primary"));
    reply
        .send(ChannelPairingOutcome::OutcomeUnknown)
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(ChannelPairingOutcome::OutcomeUnknown)
    ));
}

#[tokio::test]
async fn skill_status_uses_the_typed_actor_command() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let request = tokio::spawn({
        let handle = handle.clone();
        async move { handle.skill_status().await }
    });

    let Some(Command::SkillStatus { reply }) = receiver.recv().await else {
        panic!("Host owner must submit the fixed skill-status command");
    };
    reply
        .send(crate::skill_status::Outcome::Unavailable)
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(crate::skill_status::Outcome::Unavailable)
    ));
}

#[tokio::test]
async fn skill_management_uses_the_typed_actor_command() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let command = crate::skill_management::Command::readme("web-search".into(), None, None)
        .expect("test skill command must be valid");
    let request = tokio::spawn({
        let handle = handle.clone();
        async move { handle.manage_skills(command).await }
    });

    let Some(Command::SkillManagement { command, reply }) = receiver.recv().await else {
        panic!("Host owner must submit the fixed skill-management command");
    };
    let crate::skill_management::Command::Readme {
        skill_key,
        file_path,
        base_dir,
    } = command
    else {
        panic!("Host owner must preserve the typed skill-management command");
    };
    assert_eq!(skill_key, "web-search");
    assert_eq!(file_path, None);
    assert_eq!(base_dir, None);
    reply
        .send(crate::skill_management::Outcome::Unavailable)
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(crate::skill_management::Outcome::Unavailable)
    ));
}

#[tokio::test]
async fn session_request_returns_the_openclaw_port_error() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let request = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .list_open_claw_sessions(SessionsListParams::default())
                .await
        }
    });

    let Some(Command::Runtime(RuntimeCommand::ListSessions { reply, .. })) = receiver.recv().await
    else {
        panic!("Host owner must submit a list-sessions command");
    };
    reply
        .send(Err(RuntimeSessionError::Client(
            OpenClawSessionError::Protocol,
        )))
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(Err(RuntimeSessionError::Client(
            OpenClawSessionError::Protocol,
        )))
    ));
}

#[tokio::test]
async fn team_skill_materialization_uses_the_private_actor_command_channel() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let selection_id = TeamSkillSelectionId::parse(format!("teamskill:v1:{}", "a".repeat(64)))
        .expect("fixed opaque selection must be valid");
    let team_id = TeamId::try_new("team:research").expect("fixed team must be valid");
    let idempotency_key = IdempotencyKey::try_new("materialize:research")
        .expect("fixed idempotency key must be valid");
    let request = tokio::spawn({
        let handle = handle.clone();
        let selection_id = selection_id.clone();
        let team_id = team_id.clone();
        let idempotency_key = idempotency_key.clone();
        async move {
            handle
                .materialize_team_skill_selection(selection_id, team_id, idempotency_key)
                .await
        }
    });

    let Some(Command::TeamSkill(TeamSkillCommand::Materialize {
        selection_id: actual_selection,
        team_id: actual_team,
        idempotency_key: actual_idempotency_key,
        reply,
    })) = receiver.recv().await
    else {
        panic!("Host owner must submit a private TeamSkill materialization command");
    };
    assert_eq!(actual_selection.as_str(), selection_id.as_str());
    assert_eq!(actual_team, team_id);
    assert_eq!(actual_idempotency_key, idempotency_key);
    reply
        .send(TeamMaterializationCommandOutcome::OutcomeUnknown)
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(TeamMaterializationCommandOutcome::OutcomeUnknown)
    ));
}

#[tokio::test]
async fn manual_team_materialization_and_run_create_use_one_private_actor_command() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let team_id = TeamId::try_new("team:manual").unwrap();
    let endpoint = RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap();
    let roles = vec![
        organization::ManualTeamRoleBinding::try_new(
            RoleId::try_new("leader").unwrap(),
            "Lead",
            organization::ManagedAgentReference::try_new("selected-agent").unwrap(),
            true,
        )
        .unwrap(),
    ];
    let materialization_key = IdempotencyKey::try_new("materialize:manual").unwrap();
    let input = crate::composition::ManualTeamMaterializationInput {
        team_id: team_id.clone(),
        team_name: "Manual Team".to_owned(),
        endpoint: endpoint.clone(),
        roles: roles.clone(),
        materialization_idempotency_key: materialization_key.clone(),
        run: team_run_facts(),
        run_idempotency_key: "run:manual".to_owned(),
    };
    let request = tokio::spawn({
        let handle = handle.clone();
        async move { handle.materialize_manual_team_and_create_run(input).await }
    });

    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit one private manual Team materialization command");
    };
    let TeamRunCommand::MaterializeManualAndCreate { input, reply } = *command else {
        panic!("Host owner must submit one private manual Team materialization command");
    };
    assert_eq!(input.team_id, team_id);
    assert_eq!(input.team_name, "Manual Team");
    assert_eq!(input.endpoint, endpoint);
    assert_eq!(input.roles, roles);
    assert_eq!(input.materialization_idempotency_key, materialization_key);
    assert_eq!(input.run.run_id(), &GraphRunId::new("run:one"));
    assert_eq!(input.run_idempotency_key, "run:manual");
    reply
        .send(ManualTeamCreateOutcome::OutcomeUnknown)
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(ManualTeamCreateOutcome::OutcomeUnknown)
    ));
}

#[tokio::test]
async fn team_run_list_and_resume_use_the_actor_command_channel() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };

    let list = tokio::spawn({
        let handle = handle.clone();
        async move { handle.list_team_runs(team()).await }
    });
    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit a TeamRun list command");
    };
    let TeamRunCommand::List { team_id, reply } = *command else {
        panic!("Host owner must submit a TeamRun list command");
    };
    assert_eq!(team_id, team());
    reply
        .send(vec![TeamRunQueryOutcome::OutcomeUnknown])
        .expect("request receiver must remain open");
    assert!(matches!(
        list.await.expect("request task must complete"),
        Ok(outcomes) if outcomes == vec![TeamRunQueryOutcome::OutcomeUnknown]
    ));

    let resume = tokio::spawn({
        let handle = handle.clone();
        async move { handle.resume_team_runs(team()).await }
    });
    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit a TeamRun resume command");
    };
    let TeamRunCommand::Resume { team_id, reply } = *command else {
        panic!("Host owner must submit a TeamRun resume command");
    };
    assert_eq!(team_id, team());
    reply
        .send(vec![organization::ResumeOutcome::OutcomeUnknown(
            GraphRunId::new("run:one"),
        )])
        .expect("request receiver must remain open");
    assert!(matches!(
        resume.await.expect("request task must complete"),
        Ok(outcomes) if outcomes == vec![organization::ResumeOutcome::OutcomeUnknown(GraphRunId::new("run:one"))]
    ));
}

#[tokio::test]
async fn team_run_cancellation_and_tombstone_use_the_actor_command_channel() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };

    let begin = tokio::spawn({
        let handle = handle.clone();
        async move {
            handle
                .begin_team_run_cancellation(GraphRunId::new("run:one"), "cancel:one".to_owned(), 5)
                .await
        }
    });
    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit the complete TeamRun cancellation command");
    };
    let TeamRunCommand::BeginCancellation {
        run_id,
        idempotency_key,
        requested_at,
        reply,
    } = *command
    else {
        panic!("Host owner must submit the complete TeamRun cancellation command");
    };
    assert_eq!(run_id, GraphRunId::new("run:one"));
    assert_eq!(idempotency_key, "cancel:one");
    assert_eq!(requested_at, 5);
    reply
        .send(Err(StoreFault::WriterBusy))
        .expect("request receiver must remain open");
    assert!(matches!(
        begin.await.expect("request task must complete"),
        Ok(Err(StoreFault::WriterBusy))
    ));

    let tombstone = tokio::spawn(async move {
        handle
            .tombstone_team_run(GraphRunId::new("run:one"), "delete:one".to_owned(), 7)
            .await
    });
    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit a TeamRun tombstone command");
    };
    let TeamRunCommand::Tombstone {
        run_id,
        idempotency_key,
        tombstoned_at,
        reply,
    } = *command
    else {
        panic!("Host owner must submit a TeamRun tombstone command");
    };
    assert_eq!(run_id, GraphRunId::new("run:one"));
    assert_eq!(idempotency_key, "delete:one");
    assert_eq!(tombstoned_at, 7);
    reply
        .send(Err(StoreFault::WriterBusy))
        .expect("request receiver must remain open");
    assert!(matches!(
        tombstone.await.expect("request task must complete"),
        Ok(Err(StoreFault::WriterBusy))
    ));
}

#[tokio::test]
async fn team_run_graph_replacement_uses_the_actor_command_channel() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let definition = graph_definition("graph:replacement");
    let command = graph_replace_command(definition.clone());
    let request = tokio::spawn({
        let handle = handle.clone();
        async move { handle.replace_team_run_graph(command, definition).await }
    });

    let Some(Command::TeamRun(team_run)) = receiver.recv().await else {
        panic!("Host owner must submit the fixed TeamRun graph replacement command");
    };
    let TeamRunCommand::ReplaceGraph {
        command,
        definition,
        reply,
    } = *team_run
    else {
        panic!("Host owner must submit the fixed TeamRun graph replacement command");
    };
    assert_eq!(definition, graph_definition("graph:replacement"));
    assert_eq!(command, Box::new(graph_replace_command(definition.clone())));
    reply
        .send(Err(StoreFault::WriterBusy))
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(Err(StoreFault::WriterBusy))
    ));
}

#[tokio::test]
async fn team_run_trigger_fire_uses_the_actor_command_channel() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let fire = trigger_fire_request();
    let request = tokio::spawn({
        let handle = handle.clone();
        async move { handle.fire_team_run_trigger(fire, 5).await }
    });

    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit the fixed TeamRun trigger fire command");
    };
    let TeamRunCommand::FireTrigger {
        request: fire,
        fired_at,
        reply,
    } = *command
    else {
        panic!("Host owner must submit the fixed TeamRun trigger fire command");
    };
    assert_eq!(fire, trigger_fire_request());
    assert_eq!(fired_at, 5);
    reply
        .send(Err(StoreFault::WriterBusy))
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(Err(StoreFault::WriterBusy))
    ));
}

#[tokio::test]
async fn team_run_role_chat_admission_uses_the_actor_command_channel() {
    let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    let handle = Handle {
        commands,
        shutdown,
        state: None,
    };
    let admission = RoleChatAdmission::new(
        TeamId::try_new("team:one").unwrap(),
        GraphRunId::new("run:one"),
        RoleId::try_new("leader").unwrap(),
        "private prompt canary",
        "role-chat:one",
        5,
    )
    .unwrap();
    let request = tokio::spawn({
        let handle = handle.clone();
        async move { handle.admit_team_run_role_chat(admission).await }
    });

    let Some(Command::TeamRun(command)) = receiver.recv().await else {
        panic!("Host owner must submit a TeamRun role-chat admission command");
    };
    let TeamRunCommand::AdmitRoleChat { admission, reply } = *command else {
        panic!("Host owner must submit a TeamRun role-chat admission command");
    };
    assert_eq!(admission.team_id().as_str(), "team:one");
    assert_eq!(admission.run_id().as_str(), "run:one");
    assert_eq!(admission.role_id().as_str(), "leader");
    assert!(!format!("{admission:?}").contains("private prompt canary"));
    reply
        .send(Ok(RoleChatAdmissionOutcome::OutcomeUnknown))
        .expect("request receiver must remain open");

    assert!(matches!(
        request.await.expect("request task must complete"),
        Ok(Ok(RoleChatAdmissionOutcome::OutcomeUnknown))
    ));
}

#[test]
fn team_run_actor_dto_is_absent_from_private_control_wire() {
    let command = include_str!("command.rs");
    let wire = include_str!("../control/wire.rs");

    assert!(!command.contains(concat!("NativeWorkspace", "Grant")));
    assert!(!command.contains("DeliverMatcha"));
    assert!(!command.contains("DeliverOpenClaw"));
    assert!(!command.contains("PromptMatchaDelivery"));
    assert!(!command.contains(concat!("RoleSession", "Request")));
    assert!(!command.contains(concat!("create_role_", "session")));
    assert!(!command.contains(concat!("start_role_", "session")));
    assert!(!command.contains("MatchaSessionId"));
    assert!(!command.contains("MatchaRunId"));
    assert!(!command.contains("ExternalSessionReference"));
    assert!(!command.contains("NativeRunReceiptReference"));
    assert!(!command.contains("TerminalObservationRequest"));
    let watched_terminal = command
        .split("ObserveTerminalWatch {")
        .nth(1)
        .expect("terminal watch follow-up must remain a private actor command");
    assert!(watched_terminal.contains("delivery_id"));
    for native in [
        "RoleSessionId",
        "RoleRunId",
        "MatchaSessionId",
        "MatchaRunId",
        "ExternalSessionReference",
        "NativeRunReceiptReference",
        "RoleTerminalWatch",
        "RawEvent",
        "EventEnvelope",
    ] {
        assert!(!watched_terminal.contains(native));
    }
    assert!(!wire.contains("TeamRunQuery"));
    assert!(!wire.contains("TeamRunCommand"));
    assert!(!wire.contains("TeamRunProjection"));
    assert!(!wire.contains("TriggerFireRequest"));
    assert!(!wire.contains("FireTrigger"));
    assert!(!wire.contains("TerminalObservationRequest"));
    assert!(!wire.contains("MatchaTerminalObservationOutcome"));
    assert!(!wire.contains("ObserveMatchaTerminal"));
    assert!(!wire.contains("ObserveTerminalWatch"));
    assert!(!wire.contains("DeliverMatcha"));
    assert!(!wire.contains("PromptMatchaDelivery"));
    assert!(!wire.contains("MatchaDeliveryDispatch"));
    assert!(!wire.contains("RolePrompt"));
    assert!(!wire.contains("CreateGraphRunOutcome"));
    assert!(!wire.contains("BeginCancellationOutcome"));
    assert!(!wire.contains("SettleCancellationOutcome"));
    assert!(!wire.contains("TombstoneOutcome"));
    assert!(!wire.contains("BeginCancellation"));
    assert!(!wire.contains("SettleCancellation"));
    assert!(!wire.contains("Tombstone"));
    assert!(!wire.contains("RoleSessionId"));
    assert!(!wire.contains("NativeWorkspaceGrant"));
}

fn team() -> TeamId {
    TeamId::try_new("team:one").expect("test team identifier must be valid")
}

fn team_run_facts() -> GraphRunFacts {
    GraphRunFacts::new(
        team(),
        TeamRevision::initial(),
        GraphState::initialize(graph_definition("graph:one"), 1),
        None,
    )
    .expect("test TeamRun facts must be valid")
}

fn graph_definition(graph_id: &str) -> GraphDefinition {
    GraphDefinition::new(
        graph_id,
        "plan:one",
        GraphRunId::new("run:one"),
        "TeamRun test graph",
        vec![NodeDefinition::start(
            NodeId::new("start"),
            "Start",
            std::num::NonZeroU32::MIN,
            None,
        )],
        Vec::new(),
    )
    .expect("test graph definition must be valid")
}

fn graph_replace_command(definition: GraphDefinition) -> RunCommand {
    RunCommand::new(
        OpaqueId::try_new("run:one").expect("test run id must be valid"),
        OpaqueId::try_new("command:replace").expect("test command id must be valid"),
        OpaqueId::try_new("replace:one").expect("test idempotency key must be valid"),
        CommandPayload::GraphReplace(definition),
        5,
    )
}

fn trigger_fire_request() -> TriggerFireRequest {
    TriggerFireRequest::try_new("run:one", "start", TriggerSource::Webhook, "request:one").unwrap()
}

#[tokio::test]
async fn cancelled_join_can_resume_the_owned_task() {
    let (release, release_receiver) = oneshot::channel();
    let (task, _) = foundation::execution::OwnedTask::spawn(|_| async move {
        release_receiver
            .await
            .expect("test must release owner task");
        Ok(())
    });
    let mut owner = Owner {
        handle: None,
        task,
        events: None,
    };

    let mut join = Box::pin(owner.join());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), &mut join)
            .await
            .is_err()
    );
    drop(join);

    release.send(()).expect("owned task must remain alive");
    assert!(owner.join().await.unwrap().is_ok());
}
