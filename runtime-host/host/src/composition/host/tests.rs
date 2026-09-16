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

use crate::composition::RuntimeShutdownOutcome;
use environment::{
    ProviderAccountId, ProviderAccountStore, ProviderModelCapability, ProviderModelReference,
    ProviderModelStore, ProviderRoute, ProviderRouting, ProviderRoutingCapability,
    ProviderRoutingRevision,
};
use matcha_agent::lifecycle::{output::StartupDiagnosticCategory, secret::Secret};
use openclaw::{
    gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
    lifecycle::state_dir::CanonicalStateDir,
};
use organization::{
    DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, MemberId,
    NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind, StartTrigger,
    TeamDefinition, TeamFacts, TeamId, TeamMember, TeamRevision, TeamRole, TriggerFireRequest,
    TriggerRegistration, TriggerSource,
};
use serde_json::json;

use super::*;
use crate::{
    composition::admission::HostPhase,
    diagnostics::{HostLifecycle, RuntimeLifecycle},
    host_actor::Owner,
    sessions::model_selection::{
        NativeEndpoint as SessionModelSelectionNativeEndpoint, SessionModelSelectionCommand,
        SessionModelSelectionOutcome,
    },
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

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
        let matcha_template_directory = base.join("resources/agent-workspace-templates/main-agent");
        fs::create_dir_all(&template_directory).unwrap();
        fs::create_dir_all(&matcha_template_directory).unwrap();
        fs::write(
            matcha_template_directory.join("IDENTITY.md"),
            "# IDENTITY.md\n\n- **名字：** Matcha\n",
        )
        .unwrap();
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
    let (mut host, _events, handles) = Host::new(host_input).expect("construct host");
    host.start_admission_only().await.expect("start host");
    assert!(matches!(
        handles.provider.list_provider_accounts().await.unwrap(),
        crate::provider::accounts::ProviderAccountsDelivery::List(ref accounts)
            if accounts.len() == 1 && accounts[0].id == "local-ollama"
    ));

    let model = crate::provider::models::ProviderModelDraft {
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
        handles
            .provider
            .replace_provider_models(account_id.as_str().to_owned(), vec![model])
            .await
            .unwrap(),
        crate::provider::models::ProviderModelReplaceOutcome::DesiredStored { .. }
    ));
    let durable_models = ProviderModelStore::open(
        root.state_parent
            .join("openclaw/matchaclaw-provider-models.json"),
    )
    .expect("open provider model store");
    let expected_selection_id = durable_models
        .catalog()
        .models()
        .iter()
        .find(|model| {
            model.account_id().as_str() == "local-ollama" && model.model_id() == "llama-3.3"
        })
        .expect("provider model must be durable")
        .selection_id();
    let models = handles.provider.list_provider_models().await.unwrap();
    assert!(
        matches!(
            models,
            crate::provider::models::ProviderModelListOutcome::Available(ref models)
                if models.len() == 1
                    && models[0].account_id == "local-ollama"
                    && models[0].model_id == "llama-3.3"
        ),
        "unexpected provider models: {models:?}"
    );
    assert!(matches!(
        handles
            .provider
            .selectable_provider_models(ProviderModelCapability::Chat)
            .await
            .unwrap(),
        crate::provider::models::ProviderModelSelectableOutcome::Available(ref models)
            if models.len() == 1
                && models[0].selection_id == expected_selection_id
    ));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(root.state_parent.join("openclaw/openclaw.json"))
                .expect("read projected OpenClaw config"),
        )
        .expect("parse projected OpenClaw config")["models"]["providers"]["ollama-local-ollama"]["models"],
        json!([{
            "id": "llama-3.3",
            "name": "llama-3.3",
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192,
        }]),
    );

    let routing_revision = match handles.provider.list_provider_routing().await.unwrap() {
        crate::provider::routing::ProviderRoutingListOutcome::Desired(Some(routing)) => {
            routing.revision + 1
        }
        crate::provider::routing::ProviderRoutingListOutcome::Desired(None) => 1,
        crate::provider::routing::ProviderRoutingListOutcome::Unavailable => {
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
    let routing_outcome = handles
        .provider
        .replace_provider_routing(routing)
        .await
        .unwrap();
    assert!(
        matches!(
            routing_outcome,
            crate::provider::routing::ProviderRoutingReplaceOutcome::DesiredStored { .. }
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
        include_str!("mod.rs"),
        include_str!("../../runtime/adapters/openclaw/mod.rs"),
        include_str!("session_shutdown.rs"),
        include_str!("shutdown.rs"),
    ];

    for source in sources {
        assert!(!source.contains("gateway::client::GatewayClient,"));
        assert!(!source.contains("session::client::SessionClient"));
    }
    assert!(
        include_str!("../../runtime/adapters/openclaw/mod.rs")
            .contains("gateway: Arc<Mutex<OpenClawGateway>>")
    );
    assert!(!include_str!("mod.rs").contains(concat!(".invalidate", "_session()")));
    assert!(!include_str!("shutdown.rs").contains(concat!(".close", "_session()")));
}

#[tokio::test]
async fn created_host_shuts_down_both_idle_owners_and_retains_terminal_state() {
    let root = TestRoot::new();
    let (mut host, _events, _handles) = Host::new(host_input(&root)).unwrap();

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
    assert_eq!(report.matcha(), Some(&RuntimeShutdownOutcome::NoProcess));
    assert_eq!(report.open_claw(), Some(&RuntimeShutdownOutcome::NoProcess));
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
    let (mut host, _events, _handles) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert!(host.state().ok());

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn openclaw_prelaunch_projection_failure_does_not_block_host_startup() {
    let root = TestRoot::new();
    let (mut host, _events, _handles) = Host::new(host_input(&root)).unwrap();
    fs::write(
        root.state_parent.join("openclaw/openclaw.json"),
        b"not-json",
    )
    .unwrap();

    host.start().await.unwrap();
    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);

    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn auto_openclaw_port_guard_failure_records_start_failure_without_blocking_host_ready() {
    let root = TestRoot::new();
    let port_guard = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, root.openclaw_port))
        .expect("occupy OpenClaw gateway port");
    let (mut host, _events, _handles) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if host.open_claw_start_failure() == Some(RuntimeStartFailure::CompletionFailed) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("OpenClaw autostart failure must be recorded");
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);

    drop(port_guard);
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn diagnostics_facade_requires_a_ready_host_and_closes_after_shutdown() {
    let root = TestRoot::new();
    let (mut host, _events, handles) = Host::new(host_input(&root)).unwrap();
    let cancellation = crate::diagnostics::DiagnosticsArchiveCancellation::new();

    assert!(
        handles
            .diagnostics
            .collect_archive(cancellation.clone())
            .await
            .is_err()
    );

    host.start().await.unwrap();
    let receipt = handles
        .diagnostics
        .collect_archive(cancellation)
        .await
        .unwrap();
    assert_eq!(
        receipt.terminal(),
        crate::diagnostics::DiagnosticsArchiveTerminal::Completed
    );
    assert!(receipt.entries() > 0);
    assert!(receipt.bytes() > 0);

    host.shutdown().await.unwrap();

    assert!(
        handles
            .diagnostics
            .collect_archive(crate::diagnostics::DiagnosticsArchiveCancellation::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn matcha_startup_diagnostic_is_projected_once_without_private_details() {
    let root = TestRoot::new();
    let (mut host, _events, _handles) = Host::new(host_input(&root)).unwrap();

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
async fn peer_lifecycle_failures_do_not_shut_down_the_host() {
    let root = TestRoot::new();
    let (mut host, _events, handles) = Host::new(host_input(&root)).unwrap();

    host.start_admission_only().await.unwrap();

    assert_eq!(
        handles.peer.stop_open_claw().await.unwrap().unwrap_err(),
        super::super::peer::StopOpenClawError::RuntimeStop
    );
    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);

    assert_eq!(
        handles.peer.restart_open_claw().await.unwrap().unwrap_err(),
        super::super::peer::RestartOpenClawError::RuntimeRestart
    );
    assert_eq!(host.admission_state().phase(), HostPhase::Ready);
    assert_eq!(host.state().lifecycle(), HostLifecycle::Ready);

    host.shutdown().await.unwrap();
}

#[test]
fn successful_openclaw_lifecycle_transitions_recover_only_durable_receipts() {
    let organization_actor = include_str!("../../organization/actor.rs");
    let peer_actor = include_str!("../peer/actor.rs");

    assert_eq!(
        peer_actor
            .matches("recover_materialization_receipts().await")
            .count(),
        3
    );
    assert!(organization_actor.contains("async fn recover_materialization_receipts"));
    assert!(organization_actor.contains("materialization_receipt_recovery_teams()"));
    assert!(organization_actor.contains("ops.recover_team_materialization(request).await"));
    assert!(organization_actor.contains("confirm_team_materialization(receipt)"));
    assert!(!organization_actor.contains("team::recover_team_materialization("));
}

#[test]
fn peer_lifecycle_commands_are_owned_by_peer_owner_runtime() {
    let host = include_str!("mod.rs");
    let peer_actor = include_str!("../peer/actor.rs");
    let peer_command = include_str!("../peer/command.rs");
    let peer_query = include_str!("../peer/query.rs");
    let peer_handle = include_str!("../peer/handle.rs");
    let runtime_directory = include_str!("../../runtime/directory.rs");
    let runtime_driver = include_str!("../../runtime/driver.rs");
    let owner_actor = include_str!("../../host_actor/actor.rs");
    let owners = include_str!("owner_runtime.rs");
    let shutdown = include_str!("shutdown.rs");

    assert!(owners.contains("crate::runtime::directory::RuntimeDriverDirectory::fixed_peers("));
    assert!(!owners.contains("runtime_directory.register_openclaw"));
    assert!(!owners.contains("runtime_directory.register(matcha_driver)"));
    assert!(owners.contains("let peer_owner = super::super::peer::PeerOwner::new("));
    assert!(
        owners.contains("let (peer_owner_handle, peer_task) = owner_runtime_system.spawn_owner(")
    );
    assert!(owners.contains(
        "foundation::execution::OwnerRuntimeConfig::new(\n            64,\n            super::super::peer::PeerOwner::lane_retention(),"
    ));

    assert!(host.contains("peer_handle: PeerHandle"));
    assert!(owners.contains("peer: peer_task"));
    assert!(peer_handle.contains("OwnerRuntimeHandle<PeerCommand, PeerQuery>"));
    assert!(peer_handle.contains("send_command(command(reply))"));
    assert!(peer_handle.contains("send_query(query(reply))"));

    assert!(peer_actor.contains("impl OwnerSpec for PeerOwner"));
    assert!(peer_actor.contains("RuntimeDriverDirectory"));
    assert!(peer_actor.contains("runtime_directory"));
    assert!(peer_actor.contains("async fn handle_keyed_command("));
    assert!(peer_actor.contains("shared: Self::Shared,"));
    assert!(peer_actor.contains("key: Self::Key,"));
    assert!(peer_actor.contains(".lookup(&key)"));
    assert!(peer_actor.contains("driver.lifecycle_ops()"));
    for lifecycle_operation in [
        "lifecycle.start().await",
        "lifecycle.stop().await",
        "lifecycle.restart().await",
    ] {
        assert!(
            peer_actor.contains(lifecycle_operation),
            "PeerOwner lifecycle command must use {lifecycle_operation}"
        );
    }
    for lifecycle_command in [
        "PeerCommand::StartMatcha",
        "PeerCommand::StopMatcha",
        "PeerCommand::RestartMatcha",
        "PeerCommand::StartOpenClaw",
        "PeerCommand::StopOpenClaw",
        "PeerCommand::RestartOpenClaw",
    ] {
        assert!(peer_actor.contains(lifecycle_command));
    }
    assert!(runtime_directory.contains("pub(crate) fn lookup("));
    assert!(runtime_directory.contains("open_claw: Option<Arc<dyn RuntimeDriver>>"));
    assert!(!runtime_directory.contains("HashMap"));
    assert!(!runtime_directory.contains("pub(crate) fn register_openclaw"));
    assert!(runtime_driver.contains("pub(crate) trait LifecycleOps"));
    assert!(runtime_driver.contains("fn start(&self)"));
    assert!(runtime_driver.contains("fn stop(&self)"));
    assert!(runtime_driver.contains("fn restart(&self)"));
    assert!(
        peer_command.contains("Self::AutostartMatcha")
            && peer_command.contains("Self::AutostartOpenClaw")
    );
    assert!(peer_handle.contains("PeerCommand::AutostartMatcha"));
    assert!(peer_handle.contains("PeerCommand::AutostartOpenClaw"));
    assert!(!peer_command.contains("CommandRoute::Global"));
    assert!(!peer_actor.contains("request_peer_autostart(&shared"));
    assert!(!peer_actor.contains("async fn request_peer_autostart("));
    assert!(
        peer_command
            .contains("CommandRoute::Keyed(RuntimeDriverIdentity::matcha_agent().endpoint())")
    );
    assert!(
        peer_command.contains("CommandRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())")
    );
    assert!(
        peer_query.contains(
            "Self::State { .. } | Self::MatchaStatus { .. } | Self::OpenClawStatus { .. }"
        )
    );
    assert!(peer_query.contains("QueryRoute::Direct"));
    assert!(
        peer_query.contains("QueryRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())")
    );
    assert!(peer_handle.contains("Directory::from_host_state(&state)"));
    assert!(!peer_handle.contains("snapshot_control().await"));

    for removed in [
        "shared.matcha.request_start().await",
        "shared.matcha.start().await",
        "shared.matcha.stop().await",
        "shared.matcha.restart().await",
        "shared.matcha.advance_source_epoch()",
        "shared.open_claw.owner().start().await",
        "shared.open_claw.owner().stop().await",
        "shared.open_claw.owner().restart().await",
        "openclaw::lifecycle::port_guard::ensure_gateway_port_available",
        "prepare_openclaw_plugin_readiness",
        "reconcile_configured_channel_plugins",
        "reconcile_enabled_managed_plugins",
        "apply_startup_lifecycle",
    ] {
        assert!(
            !peer_actor.contains(removed),
            "unexpected PeerOwner lifecycle or preparation path: {removed}"
        );
    }

    for source in [peer_actor, host, owner_actor, shutdown] {
        for removed in [
            "fallback",
            "bridge",
            "dual path",
            "dual_path",
            "dual lifecycle",
        ] {
            assert!(
                !source.contains(removed),
                "unexpected lifecycle migration residue: {removed}"
            );
        }
    }

    for source in [host, owner_actor, shutdown] {
        for removed in [
            "PEER_LIFECYCLE_OPERATION_CAPACITY",
            "peer_lifecycle_operations",
            "start_matcha_operation",
            "restart_open_claw_operation",
            "reap_peer_lifecycle_operations",
            "cancel_peer_lifecycle_operations",
            "PeerAutostart",
            "MatchaCommand",
            "RuntimeCommand::Start",
            "RuntimeCommand::Stop",
            "RuntimeCommand::Restart",
            "RuntimeCommand::Logs",
            "RuntimeCommand::GatewayHealth",
            "RuntimeCommand::GatewayStatus",
            "RuntimeCommand::ControlUiUrl",
            "RuntimeCommand::ControlLease",
        ] {
            assert!(
                !source.contains(removed),
                "unexpected legacy symbol: {removed}"
            );
        }
    }
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
    let (host, events, handles) = Host::new(input).unwrap();
    let mut owner = crate::host_actor::Owner::spawn(host, events);
    let handle = handles.organization.clone();
    let request = trigger_fire_request("start", "request:one");

    let recorded = handle
        .trigger_fire(request.clone(), 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recorded.registration,
        TriggerRegistration::Recorded(request.clone())
    );
    assert!(matches!(
        recorded.run,
        crate::organization::team_run::TeamRunCommandOutcome::Unavailable
    ));

    let replayed = handle.trigger_fire(request, 3).await.unwrap().unwrap();
    assert_eq!(
        replayed.registration,
        TriggerRegistration::Replayed(trigger_fire_request("start", "request:one"))
    );

    let conflicted = handle
        .trigger_fire(trigger_fire_request("alternate", "request:one"), 4)
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
        crate::organization::team_run::TeamRunCommandOutcome::Unavailable
    ));

    assert!(owner.handle().shutdown().await.unwrap().terminal);
    assert!(owner.join().await.unwrap().is_ok());
}

#[test]
fn matcha_terminal_readback_stays_in_teamrun_receipt_router_native_watches() {
    let host = include_str!("mod.rs");
    let receipt_router = include_str!("../../organization/receipt_router.rs");
    let matcha = include_str!("../../runtime/adapters/matcha_agent/ops/team_terminal.rs");
    let crate_root = include_str!("../../lib.rs");
    let control_wire = include_str!("../../control/wire.rs");

    assert!(!host.contains("read_matcha_terminal_receipt"));
    assert!(receipt_router.contains("struct TerminalWatches"));
    assert!(receipt_router.contains("fn watch_matcha_terminal("));
    assert!(matcha.contains("impl TeamTerminalOps for MatchaRuntimeDriver"));
    assert!(matcha.contains("watch_role_terminal"));
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
fn team_scheduler_is_owned_by_organization_runtime_and_not_root_actor() {
    let host = include_str!("mod.rs");
    let root_actor = include_str!("../../host_actor/actor.rs");
    let organization_actor = include_str!("../../organization/actor.rs");
    let organization_handle = include_str!("../../organization/handle.rs");
    let supervisor = include_str!("../../organization/supervisor.rs");
    let run_actor = include_str!("../../organization/run_actor.rs");
    let receipt_router = include_str!("../../organization/receipt_router.rs");
    let owners = include_str!("owner_runtime.rs");

    assert!(!host.contains("schedule_team_run_ready_nodes"));
    assert!(!root_actor.contains("schedule_team_run_ready_nodes"));
    assert!(organization_actor.contains("impl OwnerSpec for OrganizationOwner"));
    assert!(organization_actor.contains("OrganizationCommand::ScheduleReadyNodes"));
    assert!(run_actor.contains("async fn wake_ready_nodes("));
    assert!(organization_actor.contains("OrganizationQuery::ActiveRunIds"));
    assert!(organization_actor.contains("OrganizationQuery::ActivityTarget"));
    assert!(organization_actor.contains("OrganizationCommand::ClaimActivity"));
    assert!(organization_actor.contains("OrganizationCommand::SettleActivity"));
    assert!(organization_handle.contains("pub async fn schedule_ready_nodes("));
    assert!(organization_handle.contains("pub async fn activity_target("));
    assert!(organization_handle.contains("pub async fn claim_activity("));
    assert!(organization_handle.contains("pub async fn settle_activity("));
    assert!(
        organization_handle.contains(
            ".send_command(OrganizationCommand::ScheduleReadyNodes { run_id, now, reply })"
        )
    );
    assert!(owners.contains("TeamRunCoordinator::spawn"));
    assert!(owners.contains("admission_changes: admission.subscribe()"));
    assert!(!host.contains("team_run_coordinator: crate::organization::TeamRunCoordinatorHandle"));
    assert!(!host.contains("self.team_run_coordinator.wake()"));
    assert!(!host.contains("PeerMaintenanceHandle"));
    assert!(!host.contains("peer_maintenance"));
    assert!(receipt_router.contains("struct ActivityReceipt"));
    assert!(receipt_router.contains("pub(super) async fn route_activity_receipt("));
    assert!(!receipt_router.contains("\nstruct DeliveryReconciliationState"));
    assert!(!receipt_router.contains("\npub(super) async fn reconcile_deliveries("));
    assert!(run_actor.contains("struct TeamRunActor"));
    assert!(run_actor.contains(".schedule_ready_nodes(run_id, now)"));
    assert!(run_actor.contains("claim_activity(run_id.clone(), activity_id.clone(), claimed_at)"));
    assert!(run_actor.contains(".route_activity_receipt("));
    assert!(supervisor.contains(".active_run_ids()"));
    for removed in [
        concat!("Terminal", "Watches"),
        concat!("Delivery", "Reconciliation", "State"),
        concat!("Team", "Trigger", "Cron"),
        concat!("reconcile", "_team", "_run", "_deliveries"),
        concat!("reconcile", "_team", "_trigger", "_cron"),
        concat!("Peer", "Maintenance", "Request"),
    ] {
        assert!(
            !root_actor.contains(removed),
            "root actor retains TeamRun coordinator residue: {removed}"
        );
    }
}

#[test]
fn fleet_owner_is_spawned_by_host_owner_runtime_system() {
    let host = include_str!("mod.rs");
    let owners = include_str!("owner_runtime.rs");
    let owner_actor = include_str!("../../host_actor/actor.rs");
    let shutdown = include_str!("shutdown.rs");

    assert!(owners.contains(
        "owner_runtime_system.spawn_owner(
        fleet,"
    ));
    assert!(host.contains("pub fleet: FleetHandle"));
    assert!(owners.contains("fleet: fleet_task"));
    assert!(!host.contains("FLEET_OPERATION_CAPACITY"));
    assert!(!host.contains("fleet_connection_operations"));
    assert!(!host.contains("fleet_lifecycle_operations"));
    assert!(!host.contains("start_fleet_lifecycle_operation"));
    assert!(!host.contains("reap_fleet_operations"));
    assert!(!owners.contains("Fleet(FleetCommand)"));
    assert!(!owner_actor.contains("Fleet(FleetCommand)"));
    assert!(!owner_actor.contains("impl FleetCommand"));
    assert!(!shutdown.contains("cancel_fleet_operations"));
}

#[tokio::test]
async fn host_startup_resubmits_pending_fleet_dispatches_without_replaying_unknown() {
    let root = TestRoot::new();
    let facts_path = root.state_parent.join("runtime-host/fleet-facts.log");
    let at = SystemTime::UNIX_EPOCH;
    let pending_command = fleet::command::CommandId::try_new("command-pending").unwrap();
    let unknown_command = fleet::command::CommandId::try_new("command-unknown").unwrap();

    {
        let mut owner = fleet::FleetDeliveryOwner::open(&facts_path).unwrap();
        owner
            .put_target(
                fleet::TargetId::try_new("docker-a").unwrap(),
                fleet::FleetTargetConfig::Docker(
                    fleet::DockerTargetConfig::try_new(
                        "https://docker.example.test",
                        "runtime-agent-a",
                        "registry.example.test/runtime-agent:stable",
                        None,
                    )
                    .unwrap(),
                ),
            )
            .unwrap();
        owner
            .submit(
                fleet_delivery_request("command-pending", "key-pending", "dispatch-pending", at),
                at,
            )
            .unwrap();
        owner
            .submit(
                fleet_delivery_request("command-unknown", "key-unknown", "dispatch-unknown", at),
                at,
            )
            .unwrap();
        owner
            .begin_dispatch(
                &fleet::outbox::DispatchId::try_new("dispatch-unknown").unwrap(),
                at,
            )
            .unwrap();
    }

    let baseline = fleet::FleetDeliveryOwner::open_live(&facts_path).unwrap();
    let pending_begun_before =
        fleet_audit_count(&baseline, &pending_command, "fleet.delivery.begun");
    let unknown_begun_before =
        fleet_audit_count(&baseline, &unknown_command, "fleet.delivery.begun");
    let unknown_replay_before =
        fleet_audit_count(&baseline, &unknown_command, "fleet.delivery.replay");

    let (mut host, _events, _handles) = Host::new(host_input(&root)).unwrap();
    host.start_admission_only().await.unwrap();

    let restored = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let owner = match fleet::FleetDeliveryOwner::open_live(&facts_path) {
                Ok(owner) => owner,
                Err(fleet::store::StoreFault::WriterBusy) => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                Err(error) => panic!("failed to poll Fleet facts: {error:?}"),
            };
            if owner
                .record_for_command(&pending_command)
                .is_some_and(|record| record.phase() == fleet::outbox::DispatchPhase::Delivered)
            {
                break owner;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    assert_eq!(
        restored
            .record_for_command(&unknown_command)
            .unwrap()
            .phase(),
        fleet::outbox::DispatchPhase::OutcomeUnknown
    );
    assert_eq!(
        restored
            .record_for_command(&unknown_command)
            .unwrap()
            .attempt()
            .unwrap()
            .sequence(),
        1
    );
    assert_eq!(
        fleet_audit_count(&restored, &pending_command, "fleet.delivery.begun")
            - pending_begun_before,
        1
    );
    assert_eq!(
        fleet_audit_count(&restored, &unknown_command, "fleet.delivery.begun")
            - unknown_begun_before,
        0
    );
    assert_eq!(
        fleet_audit_count(&restored, &unknown_command, "fleet.delivery.replay")
            - unknown_replay_before,
        0
    );
    assert!(restored.pending_dispatches().next().is_none());

    host.shutdown().await.unwrap();
}

fn fleet_audit_count(
    owner: &fleet::FleetDeliveryOwner,
    command_id: &fleet::command::CommandId,
    event_name: &str,
) -> usize {
    owner
        .facts()
        .audit_entries()
        .iter()
        .filter(|entry| {
            let event = entry.event();
            event.event_name() == event_name
                && event.relations().command_id() == Some(command_id.as_str())
        })
        .count()
}

#[test]
fn cron_execution_is_owned_by_cron_facade_operation_handles() {
    let host = include_str!("mod.rs");
    let facade = include_str!("../../facade/cron.rs");
    let openclaw_cron = include_str!("../../runtime/adapters/openclaw/ops/cron.rs");
    let control_runtime = include_str!("../../control/dispatch/runtime.rs");
    let foundation = include_str!("../../../../foundation/src/execution/operation.rs");
    let manual = include_str!("../../../../integrations/openclaw/src/cron/manual.rs");

    assert!(!host.contains("cron_operations"));
    assert!(!host.contains("reap_cron_operations"));
    assert!(facade.contains("OperationHandle"));
    assert!(facade.contains("operations"));
    assert!(facade.contains("cancel_operations"));
    assert!(openclaw_cron.contains("admit_cron_execution"));
    assert!(control_runtime.contains("CronTriggerResult::Accepted"));
    assert!(manual.contains("CancellationToken"));
    assert!(foundation.contains("cancel_and_join"));
}

#[test]
fn parent_callback_events_stay_out_of_host_owner_operations() {
    let host = include_str!("mod.rs");
    let owner = include_str!("../../host_actor/mod.rs");
    let actor = include_str!("../../host_actor/actor.rs");

    assert!(!host.contains("PARENT_EVENT_OPERATION_CAPACITY"));
    assert!(!host.contains("parent_event_operations"));
    assert!(!host.contains("spawn_parent_event"));
    assert!(!host.contains("emit_parent_team_event"));
    assert!(!owner.contains("publish_new_team_events"));
    assert!(!actor.contains("publish_new_team_events"));
}

#[test]
fn host_keeps_business_operations_in_typed_owner_and_facade_entries() {
    let host = include_str!("mod.rs");
    let shutdown = include_str!("shutdown.rs");
    let owner = include_str!("../../host_actor/mod.rs");
    let actor = include_str!("../../host_actor/actor.rs");

    for (name, source) in [
        ("Host", host),
        ("Host shutdown", shutdown),
        ("root owner", owner),
        ("root actor", actor),
    ] {
        for removed in [
            "CRON_OPERATION_CAPACITY",
            "PARENT_EVENT_OPERATION_CAPACITY",
            "CronOperation",
            "ParentEventOperation",
            "cron_operations",
            "parent_event_operations",
            "reap_cron_operations",
            "cancel_cron_operations",
            "reap_parent_event_operations",
            "cancel_parent_event_operations",
            "trigger_open_claw_cron(",
            "list_cron_jobs(",
            "execute_cron_broker(",
            "load_cron_history(",
            "add_cron_job(",
            "update_cron_job(",
            "delete_cron_job(",
            "emit_parent_team_event(",
            "emit_parent_runtime_job_event(",
            "spawn_parent_event(",
            "team_run_operations",
            "team_runtime_operations",
            "TeamRunOperation",
            "TeamRuntimeOperation",
            "poll_team_run_operations",
            "poll_team_runtime_operations",
            "cancel_team_run_operations",
            "cancel_team_runtime_operations",
            "session_states:",
            "session_epoch:",
            "SessionOperation",
            "running_session_ops(",
            "list_matcha_sessions(",
            "list_open_claw_sessions(",
            "abort_session(",
            "create_session(",
            "rename_open_claw_session(",
            "delete_open_claw_session(",
            "pending_session_approvals(",
            "respond_to_session_approval(",
            "send_session(",
            "select_session_model(",
        ] {
            assert!(
                !source.contains(removed),
                "{name} retains Host-wide business operation residue: {removed}"
            );
        }
    }

    for handle in [
        "pub peer: PeerHandle",
        "pub session: SessionHandle",
        "pub provider: ProviderHandle",
        "pub settings: crate::settings::SettingsHandle",
        "pub connector: crate::connectors::ConnectorHandle",
        "pub security: crate::security::SecurityHandle",
        "pub channel: ChannelHandle",
        "pub fleet: FleetHandle",
        "pub organization: crate::organization::OrganizationHandle",
        "pub platform_runtime: crate::facade::PlatformRuntimeHandle",
        "pub platform_tools: crate::facade::PlatformToolsHandle",
        "pub plugins: crate::facade::PluginsHandle",
        "pub skills: crate::facade::SkillsHandle",
        "pub cron: crate::facade::CronHandle",
        "pub agents: crate::facade::AgentsHandle",
        "pub task_manager: crate::facade::TaskManagerHandle",
        "pub workspace: crate::facade::WorkspaceHandle",
        "pub usage: crate::facade::UsageHandle",
        "pub diagnostics: crate::facade::DiagnosticsHandle",
    ] {
        assert!(
            host.contains(handle),
            "HostHandles must expose typed business entry: {handle}"
        );
    }
}

#[tokio::test]
async fn usage_history_requires_runtime_admission() {
    let root = TestRoot::new();
    let (_host, _events, handles) = Host::new(host_input(&root)).unwrap();

    assert_eq!(
        handles.usage.recent(10).await,
        Err(crate::facade::UsageReadError::Unavailable)
    );
}

#[tokio::test]
async fn gateway_health_observation_does_not_block_state_reads() {
    let root = TestRoot::new();
    let (host, events, handles) = Host::new(host_input(&root)).unwrap();
    let _gateway = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, root.openclaw_port))
        .expect("hold OpenClaw gateway probe");
    host.admission.begin_start().unwrap();
    host.admission.publish_ready().unwrap();
    let mut owner = Owner::spawn(host, events);
    let handle = owner.handle();
    let observation = handles
        .peer
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
    let (mut host, _events, handles) = Host::new(host_input(&root)).unwrap();

    host.start().await.unwrap();

    assert!(matches!(
        handles
            .workspace
            .read_text("agent:main:test-session", "notes.txt", 2 * 1024 * 1024,),
        Err(crate::runtime::driver::WorkspaceReadFailure::Unavailable)
    ));
    assert!(matches!(
        handles
            .task_manager
            .task_manager(
                crate::tasks::manager::Command::list(
                    "main".into(),
                    "agent:main:test-session".into(),
                    None,
                )
                .unwrap(),
            )
            .await,
        Ok(crate::tasks::manager::Outcome::List(
            crate::tasks::manager::ReadOutcome::Unavailable
        ))
    ));
    assert_eq!(
        handles
            .session
            .select_model(
                SessionModelSelectionCommand::try_new(
                    SessionModelSelectionNativeEndpoint::OpenClawLocal,
                    "agent:main:test-session".into(),
                    None,
                    "anthropic/claude-opus-4-7".into(),
                )
                .unwrap()
            )
            .await
            .unwrap(),
        SessionModelSelectionOutcome::Unavailable
    );
    host.shutdown().await.unwrap();
}

fn fleet_delivery_request(
    command: &str,
    key: &str,
    dispatch: &str,
    at: SystemTime,
) -> fleet::FleetDeliveryRequest {
    let command_id = fleet::command::CommandId::try_new(command).unwrap();
    let selector = fleet::FleetTargetSelector::new(
        fleet::TargetId::try_new("docker-a").unwrap(),
        1,
        fleet::TargetKind::Docker,
    );
    fleet::FleetDeliveryRequest::try_new(
        fleet::command::CommandIntent::new(
            command_id.clone(),
            fleet::command::IdempotencyKey::try_new(key).unwrap(),
            fleet::command::CommandTarget::Node(
                fleet::topology::NodeId::try_new("node-1").unwrap(),
            ),
            fleet::command::CommandKind::ProbeNode,
            at,
        ),
        fleet::outbox::DispatchIntent::for_target(
            fleet::outbox::DispatchId::try_new(dispatch).unwrap(),
            command_id,
            platform::endpoint::NativeAgentId::try_new("agent-1").unwrap(),
            selector,
        ),
    )
    .unwrap()
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
            team_run_mcp_executable: absolute_path("runtime-host-mcp"),
            team_run_mcp_state_dir: absolute_path("runtime-host"),
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
            sealed_endpoint: None,
            sealed_token: None,
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
        runtime_observation: crate::RuntimeObservationConfig::off(),
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
