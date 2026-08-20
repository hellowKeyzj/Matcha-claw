use std::{
    fs,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    num::NonZeroU32,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use environment::{
    ProviderAccountId, ProviderAccountStore, ProviderModelCapability, ProviderModelReference,
    ProviderModelStore, ProviderRoute, ProviderRouting, ProviderRoutingCapability,
    ProviderRoutingRevision,
};
use foundation::{
    process::supervision::{SupervisorOperation, SupervisorPhase},
    process::{ShutdownOutcome, TerminationOutcome},
};
use matcha_agent::lifecycle::{output::StartupDiagnosticCategory, secret::Secret};
use openclaw::{
    gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
    lifecycle::state_dir::CanonicalStateDir,
    session::protocol::{ChatHistoryParams, RunId, SessionKey},
};
use organization::{
    DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, MemberId,
    NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind, StartTrigger,
    TeamDefinition, TeamFacts, TeamId, TeamMember, TeamRevision, TeamRole, TriggerFireRequest,
    TriggerRegistration, TriggerSource,
};

use super::*;
use crate::{
    composition::admission::HostPhase,
    diagnostics::{HostLifecycle, RuntimeLifecycle},
    owner::Owner,
    session_model_selection::{
        NativeEndpoint as SessionModelSelectionNativeEndpoint, SessionModelSelectionCommand,
        SessionModelSelectionOutcome,
    },
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

#[test]
fn provider_native_fanout_without_available_owner_is_unavailable() {
    let fanout = ProviderNativeConfigurationFanout::default();
    assert!(fanout.finish().is_none());
}

#[test]
fn provider_native_fanout_aggregates_runtime_owner_outcomes() {
    let mut fanout = ProviderNativeConfigurationFanout::default();
    fanout.push(ProviderNativeConfigurationEffect::Evidence(
        ProviderNativeConfigurationEvidence::new(
            true,
            AppliedStatus::Confirmed,
            ObservedStatus::Matches,
        ),
    ));
    fanout.push(ProviderNativeConfigurationEffect::Evidence(
        ProviderNativeConfigurationEvidence::new(
            false,
            AppliedStatus::Confirmed,
            ObservedStatus::Mismatch,
        ),
    ));
    fanout.push(ProviderNativeConfigurationEffect::Unavailable);

    let Some(ProviderNativeConfigurationEffect::Evidence(evidence)) = fanout.finish() else {
        panic!("fanout with evidence must return aggregate evidence");
    };
    assert!(evidence.changed());
    assert_eq!(evidence.applied(), AppliedStatus::Unknown);
    assert_eq!(evidence.observed(), ObservedStatus::Mismatch);
}

struct TestRoot {
    base: PathBuf,
    matcha_storage_parent: PathBuf,
    state_parent: PathBuf,
    openclaw_dir: PathBuf,
    openclaw_port: u16,
    matcha_port: u16,
    cron_transport_port: u16,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "runtime-host-composition-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        let state_parent = base.join("state");
        let matcha_storage_parent = base.join("matcha");
        fs::create_dir_all(&state_parent).unwrap();
        fs::create_dir(&matcha_storage_parent).unwrap();
        let openclaw_dir = std::fs::canonicalize(&base).unwrap().join("openclaw");
        let template_directory = openclaw_dir.join("docs/reference/templates");
        fs::create_dir_all(&template_directory).unwrap();
        for name in [
            "AGENTS.md",
            "SOUL.md",
            "TOOLS.md",
            "IDENTITY.md",
            "USER.md",
            "HEARTBEAT.md",
            "BOOTSTRAP.md",
        ] {
            fs::write(template_directory.join(name), "template").unwrap();
        }
        let [openclaw_port, matcha_port, cron_transport_port] = unused_ports();
        Self {
            matcha_storage_parent,
            state_parent,
            openclaw_dir,
            openclaw_port,
            matcha_port,
            cron_transport_port,
            base,
        }
    }

    fn relative_entries(&self) -> Vec<PathBuf> {
        fn collect(
            root: &std::path::Path,
            directory: &std::path::Path,
            entries: &mut Vec<PathBuf>,
        ) {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                entries.push(path.strip_prefix(root).unwrap().to_path_buf());
                if path.is_dir() {
                    collect(root, &path, entries);
                }
            }
        }

        let mut entries = Vec::new();
        collect(&self.base, &self.base, &mut entries);
        entries.sort();
        entries
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[tokio::test]
async fn local_account_supports_model_replace_list_selectable_and_routing_admission() {
    let root = TestRoot::new();
    let host_input = host_input(&root);
    let account_id = ProviderAccountId::try_new("local-ollama").expect("account identifier");
    let account = environment::ProviderAccount::new(
        account_id.clone(),
        environment::ProviderReference::try_new("provider:ollama").expect("provider reference"),
        environment::ProviderAccountRevision::try_new(1).expect("account revision"),
        environment::ProviderAccountConfiguration::try_new(
            environment::ProviderAccountConfigurationInput {
                label: "Local Ollama".into(),
                enabled: true,
                kind: environment::ProviderAccountKind::Chat,
                endpoint: Some(
                    environment::ProviderEndpoint::try_new("http://127.0.0.1:11434/v1")
                        .expect("endpoint"),
                ),
                protocol: Some(environment::ProviderApiProtocol::OpenAiResponses),
                media_protocol: None,
                auth_mode: environment::ProviderAccountAuthMode::Local,
                credential: None,
                created_at: "2026-08-02T00:00:00Z".into(),
                updated_at: "2026-08-02T00:00:00Z".into(),
            },
        )
        .expect("local account configuration"),
    );
    let mut accounts = ProviderAccountStore::open(
        root.state_parent
            .join("openclaw/matchaclaw-provider-accounts.json"),
    )
    .expect("open provider account store");
    accounts.persist(account).expect("persist local account");
    drop(accounts);
    let (mut host, _events) = Host::new(host_input).expect("construct host");
    host.start().await.expect("start host");
    assert!(matches!(
        host.list_provider_accounts(),
        crate::transport::provider_accounts::ProviderAccountsDelivery::List(ref accounts)
            if accounts.len() == 1
                && accounts[0].get("id").and_then(serde_json::Value::as_str) == Some("local-ollama")
    ));

    let model = crate::provider_models::ProviderModelDraft {
        model_id: "llama-3.3".into(),
        capabilities: vec![ProviderModelCapability::Chat],
        context_window: Some(128_000),
        max_tokens: Some(8_192),
        timeout_ms: None,
        aspect_ratio: None,
        resolution: None,
        quality: None,
    };
    assert!(matches!(
        host.replace_provider_models(account_id.as_str().to_owned(), vec![model])
            .await,
        crate::provider_models::ProviderModelReplaceOutcome::DesiredStored { .. }
    ));
    let durable_models = ProviderModelStore::open(
        root.state_parent
            .join("openclaw/matchaclaw-provider-models.json"),
    )
    .expect("open provider model store");
    assert!(durable_models.catalog().models().iter().any(|model| {
        model.account_id().as_str() == "local-ollama" && model.model_id() == "llama-3.3"
    }));
    let models = host.list_provider_models();
    assert!(
        matches!(
            models,
            crate::provider_models::ProviderModelListOutcome::Available(ref models)
                if models.len() == 1
                    && models[0].account_id == "local-ollama"
                    && models[0].model_id == "llama-3.3"
        ),
        "unexpected provider models: {models:?}"
    );
    assert!(matches!(
        host.selectable_provider_models(ProviderModelCapability::Chat),
        crate::provider_models::ProviderModelSelectableOutcome::Available(ref models)
            if models.len() == 1
                && models[0].selection_id == "ollama-local-ollama/llama-3.3"
    ));

    let routing_revision = match host.list_provider_routing() {
        crate::provider_routing::ProviderRoutingListOutcome::Desired(Some(routing)) => {
            routing.revision().get() + 1
        }
        crate::provider_routing::ProviderRoutingListOutcome::Desired(None) => 1,
        crate::provider_routing::ProviderRoutingListOutcome::Unavailable => {
            panic!("provider routing should be available")
        }
    };
    let routing = ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(routing_revision).expect("routing revision"),
        vec![(
            ProviderRoutingCapability::Chat,
            ProviderRoute::try_new(
                ProviderModelReference::try_new(account_id, "llama-3.3").expect("model reference"),
                Vec::new(),
                None,
            )
            .expect("route"),
        )],
    )
    .expect("routing");
    let routing_outcome = host.replace_provider_routing(routing).await;
    assert!(
        matches!(
            routing_outcome,
            crate::provider_routing::ProviderRoutingReplaceOutcome::DesiredStored { .. }
        ),
        "unexpected provider routing outcome: {routing_outcome:?}"
    );
    host.shutdown().await.expect("shutdown host");
}

#[test]
fn construction_is_atomic_and_does_not_materialize_runtime_files() {
    let root = TestRoot::new();
    let mut input = host_input(&root);
    input.open_claw.port = 0;
    let entries_before_construction = root.relative_entries();

    let error = match Host::new(input) {
        Ok(_) => panic!("invalid OpenClaw input was accepted"),
        Err(error) => error,
    };

    assert!(matches!(error, ConstructionError::OpenClaw(_)));
    assert_eq!(root.relative_entries(), entries_before_construction);
    assert!(!root.matcha_storage_parent.join("app-server").exists());
}

#[test]
fn open_claw_client_custody_stays_behind_the_concrete_port() {
    let sources = [
        include_str!("../host.rs"),
        include_str!("../openclaw.rs"),
        include_str!("../session.rs"),
        include_str!("shutdown.rs"),
    ];

    for source in sources {
        assert!(!source.contains("gateway::client::GatewayClient,"));
        assert!(!source.contains("session::client::SessionClient"));
    }
    assert!(include_str!("../openclaw.rs").contains("gateway: Arc<Mutex<OpenClawGateway>>"));
    assert!(!include_str!("../host.rs").contains(concat!(".invalidate", "_session()")));
    assert!(!include_str!("shutdown.rs").contains(concat!(".close", "_session()")));
}

#[tokio::test]
async fn created_host_shuts_down_both_idle_owners_and_retains_terminal_state() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    let report = host.shutdown().await.unwrap();

    assert_eq!(host.admission_state().phase(), HostPhase::ShutDown);
    assert_eq!(host.state().lifecycle(), HostLifecycle::ShutDown);
    assert_eq!(
        host.state().matcha().lifecycle(),
        RuntimeLifecycle::ShutDown
    );
    assert_eq!(
        host.state().open_claw().lifecycle(),
        RuntimeLifecycle::ShutDown
    );
    assert_eq!(
        report.matcha(),
        Some(&ShutdownOutcome::Terminated(TerminationOutcome::NoProcess))
    );
    assert_eq!(
        report.open_claw(),
        Some(&ShutdownOutcome::Terminated(TerminationOutcome::NoProcess))
    );
    assert_eq!(host.shutdown().await.unwrap(), report);
    assert!(
        !root
            .matcha_storage_parent
            .join("app-server/private")
            .exists()
    );
}

#[tokio::test]
async fn ready_host_admits_peer_lifecycle_requests() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert!(host.state().ok());
    assert!(host.matcha_start_failure().is_none());
    assert_eq!(host.open_claw_start_failure(), None);

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn openclaw_prelaunch_projection_failure_does_not_block_host_startup() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();
    fs::write(
        root.state_parent.join("openclaw/openclaw.json"),
        b"not-json",
    )
    .unwrap();

    host.start().await.unwrap();
    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);
    assert!(host.matcha_start_failure().is_none());
    assert_eq!(host.open_claw_start_failure(), None);

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn auto_openclaw_port_guard_failure_records_start_failure_without_blocking_host_ready() {
    let root = TestRoot::new();
    let port_guard = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, root.openclaw_port))
        .expect("occupy OpenClaw gateway port");
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);
    assert!(host.matcha_start_failure().is_none());
    assert_eq!(
        host.open_claw_start_failure(),
        Some(RuntimeStartFailure::CompletionFailed)
    );

    drop(port_guard);
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn diagnostics_admission_requires_a_ready_host_and_closes_after_shutdown() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    assert!(host.admit_diagnostics().is_err());

    host.start().await.unwrap();
    let cancellation = crate::diagnostics::DiagnosticsArchiveCancellation::new();
    let receipt = host.admit_diagnostics().unwrap().collect(&cancellation);
    assert_eq!(
        receipt.terminal(),
        crate::diagnostics::DiagnosticsArchiveTerminal::Completed
    );
    assert!(receipt.entries() > 0);
    assert!(receipt.bytes() > 0);

    host.shutdown().await.unwrap();

    assert!(host.admit_diagnostics().is_err());
}

#[tokio::test]
async fn matcha_startup_diagnostic_is_projected_once_without_private_details() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    host.matcha_startup_diagnostics
        .report(StartupDiagnosticCategory::AppServerReportedError);
    host.matcha_startup_diagnostics
        .report(StartupDiagnosticCategory::PortConflict);

    let state = host.state();
    assert_eq!(
        state.matcha().startup_diagnostic(),
        Some(StartupDiagnosticCategory::AppServerReportedError.into())
    );
    assert_eq!(
        serde_json::to_value(state).unwrap()["matcha"]["startupDiagnostic"],
        "appServerReportedError"
    );

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn peer_stop_and_restart_do_not_shut_down_the_host() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    let stop = host.stop_open_claw().await.unwrap().unwrap();
    assert_eq!(stop.lifecycle(), RuntimeLifecycle::Idle);
    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);
    assert_eq!(host.state().open_claw().lifecycle(), RuntimeLifecycle::Idle);

    let restart = host.restart_open_claw().await.unwrap().unwrap_err();
    assert_eq!(restart, RuntimeLifecycleFailure::CompletionFailed);
    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);
    assert_eq!(
        host.state().open_claw().lifecycle(),
        RuntimeLifecycle::Failed
    );

    host.shutdown().await.unwrap();
}

#[test]
fn successful_openclaw_lifecycle_transitions_recover_only_durable_receipts() {
    let host = include_str!("../host.rs");
    let recovery = host
        .split_once("async fn recover_team_materialization_receipts(&mut self) {")
        .expect("Host must define receipt-only materialization recovery")
        .1
        .split_once("    pub(crate) fn list_team_runs(")
        .expect("receipt recovery must remain distinct from its private command")
        .0;

    assert_eq!(
        host.matches("self.recover_team_materialization_receipts().await;")
            .count(),
        3
    );
    assert_eq!(
        recovery
            .matches("team::recover_team_materialization(")
            .count(),
        1
    );
    assert!(recovery.contains("materialization_receipt_recovery_teams()"));
    assert!(!recovery.contains("materialize_team("));
}

#[test]
fn peer_lifecycle_commands_are_owned_by_bounded_operation_lanes() {
    let host = include_str!("../host.rs");
    let command = include_str!("../../owner/command.rs");
    let actor = include_str!("../../owner/actor.rs");
    let shutdown = include_str!("shutdown.rs");

    assert!(host.contains("PEER_LIFECYCLE_OPERATION_CAPACITY"));
    assert!(host.contains("peer_lifecycle_operations"));
    assert!(host.contains("start_matcha_operation"));
    assert!(host.contains("restart_open_claw_operation"));
    assert!(host.contains("reap_peer_lifecycle_operations"));
    assert!(command.contains("host.start_matcha_operation(reply)"));
    assert!(command.contains("host.restart_open_claw_operation(reply)"));
    assert!(actor.contains("host.reap_peer_lifecycle_operations().await"));
    assert!(shutdown.contains("cancel_peer_lifecycle_operations"));
}

#[test]
fn team_run_private_control_is_not_in_framed_wire() {
    let control_wire = include_str!("../../control/wire.rs");
    assert!(!control_wire.contains("TeamRunCommand"));
    assert!(!control_wire.contains("TeamRunQuery"));
}

#[tokio::test]
async fn team_run_trigger_actor_projects_record_replay_and_conflict() {
    let root = TestRoot::new();
    let mut input = host_input(&root);
    input
        .organization_store
        .replace_facts(facts_with_armed_webhook_run())
        .unwrap();
    let (host, events) = Host::new(input).unwrap();
    let mut owner = crate::owner::Owner::spawn(host, events);
    let handle = owner.handle();
    let request = trigger_fire_request("start", "request:one");

    let recorded = handle
        .fire_team_run_trigger(request.clone(), 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recorded.registration,
        TriggerRegistration::Recorded(request.clone())
    );
    assert!(matches!(
        recorded.run,
        super::super::team_run::TeamRunCommandOutcome::Unavailable
    ));

    let replayed = handle
        .fire_team_run_trigger(request, 3)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        replayed.registration,
        TriggerRegistration::Replayed(trigger_fire_request("start", "request:one"))
    );

    let conflicted = handle
        .fire_team_run_trigger(trigger_fire_request("alternate", "request:one"), 4)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        conflicted.registration,
        TriggerRegistration::ConflictingIdempotencyKey {
            idempotency_key: "request:one".to_owned(),
        }
    );
    assert!(matches!(
        conflicted.run,
        super::super::team_run::TeamRunCommandOutcome::Unavailable
    ));

    assert!(owner.handle().shutdown().await.unwrap().terminal);
    assert!(owner.join().await.unwrap().is_ok());
}

#[test]
fn control_lease_probes_during_starting_or_running() {
    for operation in [
        Some(SupervisorOperation::Start),
        Some(SupervisorOperation::Restart),
        None,
    ] {
        assert_eq!(
            control_lease_projection(SupervisorPhase::Starting, operation),
            ControlLeaseProjection::ProbeGateway,
        );
    }
    for (phase, operation) in [
        (
            SupervisorPhase::WaitingToRestart,
            Some(SupervisorOperation::Restart),
        ),
        (SupervisorPhase::Idle, None),
        (SupervisorPhase::Stopping, Some(SupervisorOperation::Stop)),
        (SupervisorPhase::OperationFailed, None),
        (SupervisorPhase::ShutDown, None),
    ] {
        assert_eq!(
            control_lease_projection(phase, operation),
            ControlLeaseProjection::Unavailable,
        );
    }
    assert_eq!(
        control_lease_projection(SupervisorPhase::Running, None),
        ControlLeaseProjection::ProbeGateway,
    );
}

#[test]
fn matcha_terminal_readback_stays_in_teamrun_native_watches() {
    let host = include_str!("../host.rs");
    let actor = include_str!("../../owner/actor.rs");
    let crate_root = include_str!("../../lib.rs");
    let control_wire = include_str!("../../control/wire.rs");

    assert!(!host.contains("read_matcha_terminal_receipt"));
    assert!(host.contains("RoleTerminalWatch"));
    assert!(actor.contains("TerminalWatches"));
    assert!(actor.contains("terminal_watches.start(host, delivery_id"));
    assert!(!crate_root.contains("read_matcha_terminal_receipt"));
    assert!(!crate_root.contains("TerminalRunReceipt"));
    for matcha_terminal_receipt in [
        "read_matcha_terminal_receipt",
        "TerminalRunReceipt",
        "matcha.session.receipt",
    ] {
        assert!(!control_wire.contains(matcha_terminal_receipt));
    }
    assert!(!host.contains("session.transcript"));
}

#[test]
fn team_scheduler_is_driven_by_durable_facts_and_delivery_admission() {
    let host = include_str!("../host.rs");
    let actor = include_str!("../../owner/actor.rs");
    assert!(host.contains("schedule_team_run_ready_nodes"));
    assert!(host.contains("active_team_run_local_sessions"));
    assert!(host.contains("schedule_ready_nodes"));
    assert!(host.contains("RoleChatAdmission::new"));
    assert!(host.contains("MAX_ACTIVE_ROLE_PROMPTS: usize = 2"));
    assert!(host.contains("DeliveryPhase::Delivered"));
    assert!(actor.contains("schedule_team_run_ready_nodes"));
    assert!(actor.contains("active_team_run_ids"));
}

#[test]
fn fleet_lifecycle_is_owned_by_bounded_host_operation_lanes() {
    let host = include_str!("../host.rs");
    let owner = include_str!("../../fleet/owner.rs");
    let command = include_str!("../../owner/command.rs");
    let shutdown = include_str!("shutdown.rs");

    assert!(host.contains("FLEET_OPERATION_CAPACITY"));
    assert!(host.contains("fleet_connection_operations"));
    assert!(host.contains("fleet_lifecycle_operations"));
    assert!(host.contains("start_fleet_lifecycle_operation"));
    assert!(host.contains("reap_fleet_operations"));
    assert!(owner.contains("operation_owner"));
    assert!(command.contains("fleet_start_environment_deployment_operation"));
    assert!(shutdown.contains("cancel_fleet_operations"));
}

#[test]
fn cron_execution_is_owned_by_host_operation_handles() {
    let host = include_str!("../host.rs");
    let instance = include_str!("../openclaw.rs");
    let control = include_str!("../../control/dispatch.rs");
    let foundation = include_str!("../../../../foundation/src/execution/operation.rs");
    let manual = include_str!("../../../../integrations/openclaw/src/cron/manual.rs");

    assert!(host.contains("OperationHandle"));
    assert!(host.contains("cron_operations"));
    assert!(host.contains("reap_cron_operations"));
    assert!(instance.contains("admit_cron_execution"));
    assert!(control.contains("CronTriggerOutcome::Accepted"));
    assert!(manual.contains("CancellationToken"));
    assert!(foundation.contains("cancel_and_join"));
}

#[test]
fn parent_callback_events_use_bounded_host_operations() {
    let host = include_str!("../host.rs");
    let command = include_str!("../../owner/command.rs");
    let actor = include_str!("../../owner/actor.rs");

    assert!(host.contains("PARENT_EVENT_OPERATION_CAPACITY"));
    assert!(host.contains("parent_event_operations"));
    assert!(host.contains("spawn_parent_event"));
    assert!(host.contains("emit_parent_team_event"));
    assert!(host.contains("emit_parent_runtime_job_event"));
    assert!(command.contains("publish_new_team_events(host, &run_id, cursor);"));
    assert!(!command.contains("publish_new_team_events(host, &run_id, cursor).await"));
    assert!(actor.contains("emit_toolchain_event("));
    assert!(!actor.contains(".emit_parent_runtime_job_event(event_name, payload)\n        .await"));
}

#[tokio::test]
async fn ready_host_reads_usage_history_when_openclaw_is_not_running() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();
    let sessions = root.state_parent.join("openclaw/agents/main/sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join("live.jsonl"),
        r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"total":7}}}"#,
    )
    .unwrap();

    host.start().await.unwrap();

    let entries = host.usage_open_claw_recent(10).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].total_tokens(), 7);

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn gateway_health_observation_does_not_block_state_reads() {
    let root = TestRoot::new();
    let (host, events) = Host::new(host_input(&root)).unwrap();
    let _gateway = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, root.openclaw_port))
        .expect("hold OpenClaw gateway probe");
    host.admission.begin_start().unwrap();
    host.admission.publish_ready().unwrap();
    let mut owner = Owner::spawn(host, events);
    let handle = owner.handle();
    let observation = handle
        .open_claw_gateway_health_observation(false)
        .await
        .unwrap()
        .unwrap();

    let blocked_observation = tokio::spawn(async move { observation.observe().await });
    tokio::task::yield_now().await;

    assert!(
        tokio::time::timeout(Duration::from_millis(100), async {
            assert_eq!(handle.state().lifecycle(), HostLifecycle::Ready);
        })
        .await
        .is_ok()
    );

    blocked_observation.abort();
    let shutdown = handle.shutdown().await.unwrap();
    assert!(shutdown.terminal);
    owner.join().await.unwrap().unwrap();
}

#[tokio::test]
async fn ready_host_rejects_runtime_operations_when_runtimes_are_not_running() {
    let root = TestRoot::new();
    let (mut host, _events) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    assert!(matches!(
        host.read_open_claw_workspace_text(
            "agent:main:test-session",
            "notes.txt",
            2 * 1024 * 1024,
        ),
        Err(WorkspaceReadError::Unavailable)
    ));
    assert!(matches!(
        host.list_open_claw_sessions(SessionsListParams::default())
            .await,
        Err(RuntimeSessionError::RuntimeUnavailable)
    ));
    assert!(matches!(
        host.history_open_claw_chat(ChatHistoryParams::new(
            SessionKey::try_new("agent:main:test-session").unwrap(),
        ))
        .await,
        Err(RuntimeSessionError::RuntimeUnavailable)
    ));
    assert!(matches!(
        host.send_open_claw_chat(
            ChatSendParams::try_new(
                SessionKey::try_new("agent:main:test-session").unwrap(),
                "test message",
                RunId::try_new("test-run").unwrap(),
            )
            .unwrap(),
        )
        .await,
        Err(RuntimeSessionError::RuntimeUnavailable)
    ));
    assert!(matches!(
        host.abort_open_claw_chat(ChatAbortParams::new(
            SessionKey::try_new("agent:main:test-session").unwrap(),
        ))
        .await,
        Err(RuntimeSessionError::RuntimeUnavailable)
    ));
    assert!(matches!(
        host.task_manager(
            crate::task_manager::Command::list(
                "main".into(),
                "agent:main:test-session".into(),
                None,
            )
            .unwrap(),
        )
        .await,
        crate::task_manager::Outcome::List(crate::task_manager::ReadOutcome::Unavailable)
    ));
    assert_eq!(
        host.select_session_model(
            SessionModelSelectionCommand::try_new(
                SessionModelSelectionNativeEndpoint::OpenClawLocal,
                "agent:main:test-session".into(),
                "anthropic/claude-opus-4-7".into(),
            )
            .unwrap()
        )
        .await,
        SessionModelSelectionOutcome::Unavailable
    );
    host.shutdown().await.unwrap();
}

fn host_input(root: &TestRoot) -> HostInput {
    let state_dir = CanonicalStateDir::provision(root.state_parent.join("openclaw")).unwrap();

    HostInput {
        matcha: MatchaAgentInput {
            bun_executable: absolute_path("bin/bun"),
            entry: absolute_path("matcha-agent/dist/cli-bun.js"),
            working_directory: absolute_path("runtime"),
            storage_root: root.matcha_storage_parent.join("app-server"),
            port: root.matcha_port,
            #[cfg(windows)]
            git_bash: absolute_path("bin/bash.exe"),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        matcha_secret: Secret::new(entropy()).unwrap(),
        open_claw: OpenClawInput {
            electron_image: absolute_path("MatchaClaw"),
            working_directory: absolute_path("runtime"),
            openclaw_dir: root.openclaw_dir.clone(),
            companion_skill_source_root: root.state_parent.join("openclaw-plugins"),
            managed_plugin_root: root.state_parent.join("openclaw-plugins"),
            subagent_template_dir: {
                let path = root.state_parent.join("subagent-templates");
                fs::create_dir_all(&path).expect("create subagent template directory");
                path
            },
            entry: root.openclaw_dir.join("openclaw.mjs"),
            state_dir,
            port: root.openclaw_port,
            client_metadata: GatewayClientMetadata::try_new(
                "test".into(),
                std::env::consts::OS.into(),
            )
            .unwrap(),
            report_diagnostic: Arc::new(|_| {}),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        open_claw_secret: GatewaySecret::new(entropy()).unwrap(),
        organization_store: organization::OrganizationStore::open(
            root.state_parent.join("organization-facts.log"),
        )
        .unwrap(),
        runtime_state_dir: root.state_parent.join("runtime-host"),
        app_log_dir: root.state_parent.join("userdata-logs"),
        parent_callback_base_url: "http://127.0.0.1:34100".into(),
        parent_callback_dispatch_token: "test-parent-dispatch-token".into(),
        cron_transport_port: root.cron_transport_port,
    }
}

fn unused_ports() -> [u16; 3] {
    let listeners = std::array::from_fn::<_, 3, _>(|_| {
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("reserve test port")
    });
    listeners.map(|listener| listener.local_addr().expect("read test port").port())
}

fn facts_with_armed_webhook_run() -> OrganizationFacts {
    let team = TeamId::try_new("team:one").unwrap();
    let definition = GraphDefinition::new(
        "graph:one",
        "plan:one",
        GraphRunId::new("run:one"),
        "display",
        vec![
            NodeDefinition::start(
                NodeId::new("start"),
                "webhook start",
                NonZeroU32::new(2).unwrap(),
                Some(StartTrigger::Webhook {
                    path: "private-webhook-path".to_owned(),
                }),
            ),
            NodeDefinition::start(
                NodeId::new("alternate"),
                "alternate webhook start",
                NonZeroU32::new(2).unwrap(),
                Some(StartTrigger::Webhook {
                    path: "alternate".to_owned(),
                }),
            ),
        ],
        Vec::new(),
    )
    .unwrap();
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(team.clone()),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(
                team,
                TeamRevision::initial(),
                GraphState::initialize(definition, 1),
                None,
            )
            .unwrap(),
        ],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn team_definition(team_id: TeamId) -> TeamDefinition {
    let member_id = MemberId::try_new("member:leader").unwrap();
    let role_id = RoleId::try_new("leader").unwrap();
    TeamDefinition::try_new(
        team_id,
        "Team One",
        vec![TeamMember::try_new(member_id.clone(), "Leader").unwrap()],
        vec![TeamRole::try_new(role_id.clone(), "Leader", RoleKind::Leader).unwrap()],
        vec![RoleAssignment::new(member_id, role_id)],
    )
    .unwrap()
}

fn trigger_fire_request(start_node_id: &str, idempotency_key: &str) -> TriggerFireRequest {
    TriggerFireRequest::try_new(
        "run:one",
        start_node_id,
        TriggerSource::Webhook,
        idempotency_key,
    )
    .unwrap()
}

fn entropy() -> String {
    let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock must follow the Unix epoch")
        .as_nanos();
    format!("{nanos}-{sequence}")
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}
