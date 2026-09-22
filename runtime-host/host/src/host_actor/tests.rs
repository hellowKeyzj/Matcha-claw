use tokio::sync::{mpsc, oneshot};

use super::*;

#[tokio::test]
async fn closed_shutdown_channel_rejects_shutdown_requests() {
    let (shutdown, receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
    drop(receiver);
    let handle = Handle {
        shutdown,
        state: None,
    };

    assert!(matches!(
        handle.shutdown().await,
        Err(Error::LifecycleChannelClosed)
    ));
}

#[test]
fn root_owner_exposes_no_product_command_surface() {
    let owner = include_str!("mod.rs");

    for removed in [
        "mod command;",
        "mpsc::Sender<Command>",
        "request<T>",
        "collect_diagnostics",
        "download_diagnostics",
        "list_cron_jobs",
        "trigger_cron",
        "agents(",
        "platform_tools(",
        "skill_status(",
        "manage_skills(",
        "task_manager(",
        "runtime_paths(",
        "subagent_template(",
        "read_workspace_text",
        "usage_recent",
        "RuntimeCommand",
    ] {
        assert!(
            !owner.contains(removed),
            "unexpected host owner product surface: {removed}"
        );
    }
}

#[test]
fn generic_runtime_job_contract_and_root_command_module_stay_removed() {
    let source_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for removed in ["owner/command.rs", "projection/job_compatibility.rs"] {
        assert!(
            !source_root.join(removed).exists(),
            "removed RuntimeJob surface still exists: {removed}"
        );
    }

    let sources = [
        ("root owner", include_str!("mod.rs")),
        ("root actor", include_str!("actor.rs")),
        ("public crate", include_str!("../lib.rs")),
        (
            "private control registry",
            include_str!("../module_registry/private_control.rs"),
        ),
        ("control wire", include_str!("../control/wire.rs")),
        (
            "capability catalog",
            include_str!("../module_registry/capability_catalog.rs"),
        ),
        ("parent callback", include_str!("../parent_callback.rs")),
    ];
    for (name, source) in sources {
        for removed in [
            "RuntimeJob",
            "runtime-job",
            "runtime-jobs",
            "runtimeHost.jobGet",
            "job_compatibility",
        ] {
            assert!(
                !source.contains(removed),
                "{name} reintroduces removed RuntimeJob contract: {removed}"
            );
        }
    }
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

#[test]
fn team_runtime_owner_ingress_stays_out_of_host_owner() {
    let owner = include_str!("mod.rs");
    let actor = include_str!("actor.rs");
    let wire = include_str!("../control/wire.rs");

    for source in [owner, actor] {
        for removed in [
            "TeamSkillCommand",
            "TeamRunCommand",
            "TeamRuntimeCommand",
            "Command::TeamSkill",
            "Command::TeamRun",
            "Command::TeamRuntime",
            "team_runtime(",
            "materialize_team_skill_selection(",
            "materialize_manual_team_and_create_run(",
            "list_team_runs(",
            "fire_team_run_trigger(",
        ] {
            assert!(
                !source.contains(removed),
                "unexpected legacy team owner ingress: {removed}"
            );
        }
    }

    assert!(!wire.contains("TeamRunQuery"));
    assert!(!wire.contains("TeamRunCommand"));
    assert!(!wire.contains("TeamRunProjection"));
    assert!(!wire.contains("TriggerFireRequest"));
    assert!(!wire.contains("FireTrigger"));
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
