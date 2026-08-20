use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use super::*;

const SECRET_CANARY: &str = "workspace-private-content-canary";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
    workspace: PathBuf,
    templates: PathBuf,
    managed_templates: PathBuf,
    context: PathBuf,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openclaw-workspace-projection-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        let templates = path.join("templates");
        let managed_templates = path.join("managed-templates");
        let context = path.join("context");
        fs::create_dir_all(&templates).expect("create templates");
        fs::create_dir_all(&managed_templates).expect("create managed templates");
        fs::create_dir_all(&context).expect("create context");
        for file in WorkspaceTemplateFile::ALL {
            fs::write(
                templates.join(file.file_name()),
                format!("---\ntitle: template\n---\n{} template\n", file.file_name()),
            )
            .expect("write template");
            fs::write(
                managed_templates.join(file.file_name()),
                format!("managed {}\n", file.file_name()),
            )
            .expect("write managed template");
        }
        Self {
            workspace: path.join("workspace"),
            templates,
            managed_templates,
            context,
            path,
        }
    }

    fn request(&self) -> AgentWorkspaceMaterializationRequest {
        AgentWorkspaceMaterializationRequest::new(
            AgentWorkspaceDirectory::try_new(self.workspace.clone()).expect("workspace path"),
            WorkspaceTemplateDirectory::try_new(self.templates.clone()).expect("template path"),
        )
    }

    fn state_path(&self) -> PathBuf {
        self.workspace
            .join(WORKSPACE_STATE_DIRECTORY)
            .join(WORKSPACE_STATE_FILE)
    }

    fn materialize(&self) -> AgentWorkspaceMaterialization {
        AgentWorkspaceProjection::materialize(self.request()).expect("materialize workspace")
    }

    fn request_with_managed_templates(&self) -> AgentWorkspaceMaterializationRequest {
        self.request().with_managed_templates(
            ManagedWorkspaceTemplateDirectory::try_new(self.managed_templates.clone())
                .expect("managed template path"),
        )
    }

    fn request_with_context(&self) -> AgentWorkspaceMaterializationRequest {
        self.request().with_context(
            WorkspaceContextDirectory::try_new(self.context.clone()).expect("context path"),
        )
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn state(root: &TestRoot) -> Value {
    serde_json::from_slice(&fs::read(root.state_path()).expect("read workspace state"))
        .expect("parse workspace state")
}

fn assert_missing(path: &Path) {
    assert!(!path.exists(), "path must be absent");
}

#[test]
fn new_workspace_materializes_core_files_then_seeds_pending_bootstrap() {
    let root = TestRoot::new();

    let materialization = root.materialize();

    assert_eq!(
        materialization.initialized_files(),
        [
            WorkspaceTemplateFile::Agents,
            WorkspaceTemplateFile::Soul,
            WorkspaceTemplateFile::Tools,
            WorkspaceTemplateFile::Identity,
            WorkspaceTemplateFile::User,
            WorkspaceTemplateFile::Heartbeat,
            WorkspaceTemplateFile::Bootstrap,
        ]
    );
    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Pending
    );
    for file in WorkspaceTemplateFile::ALL {
        assert_eq!(
            fs::read_to_string(root.workspace.join(file.file_name())).expect("read workspace file"),
            format!("{} template\n", file.file_name())
        );
    }
    let state = state(&root);
    assert!(state["bootstrapSeededAt"].as_str().is_some());
    assert!(state["setupCompletedAt"].is_null());
}

#[test]
fn completed_workspace_never_recreates_bootstrap_when_a_core_file_is_restored() {
    let root = TestRoot::new();
    root.materialize();
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Identity.file_name()),
        "configured identity\n",
    )
    .expect("configure identity");
    fs::remove_file(
        root.workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    )
    .expect("remove bootstrap");
    fs::remove_file(
        root.workspace
            .join(WorkspaceTemplateFile::Tools.file_name()),
    )
    .expect("remove core file");

    let materialization = root.materialize();

    assert_eq!(
        materialization.initialized_files(),
        [WorkspaceTemplateFile::Tools]
    );
    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Complete
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Tools.file_name())
        )
        .expect("restored core file"),
        "TOOLS.md template\n"
    );
    assert!(state(&root)["setupCompletedAt"].as_str().is_some());
}

#[test]
fn configured_legacy_workspace_is_completed_without_seeding_bootstrap() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Identity.file_name()),
        "configured identity\n",
    )
    .expect("write identity");

    let materialization = root.materialize();

    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Complete
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
    let state = state(&root);
    assert!(state["bootstrapSeededAt"].is_null());
    assert!(state["setupCompletedAt"].as_str().is_some());
}

#[test]
fn user_content_prevents_bootstrap_seeding_without_modifying_the_content() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(root.workspace.join("notes.md"), SECRET_CANARY).expect("write user content");

    let materialization = root.materialize();

    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Complete
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
    assert_eq!(
        fs::read_to_string(root.workspace.join("notes.md")).expect("read user content"),
        SECRET_CANARY
    );
    assert!(state(&root)["setupCompletedAt"].as_str().is_some());
}

#[test]
fn configured_core_template_completes_workspace_without_overwriting_user_content() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Agents.file_name()),
        SECRET_CANARY,
    )
    .expect("configure agents");

    let materialization = root.materialize();

    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Complete
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Agents.file_name())
        )
        .expect("read configured agents"),
        SECRET_CANARY
    );
    assert!(state(&root)["setupCompletedAt"].as_str().is_some());
}

#[test]
fn malformed_workspace_state_fails_closed_without_writing_bootstrap() {
    let root = TestRoot::new();
    fs::create_dir_all(root.state_path().parent().expect("state parent"))
        .expect("create state parent");
    fs::write(root.state_path(), SECRET_CANARY).expect("write malformed state");

    let error = AgentWorkspaceProjection::materialize(root.request())
        .expect_err("malformed state must reject materialization");

    assert_eq!(error, WorkspaceProjectionError::StateUnavailable);
    for file in WorkspaceTemplateFile::CORE {
        assert_missing(&root.workspace.join(file.file_name()));
    }
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
    assert_eq!(
        fs::read_to_string(root.state_path()).expect("read malformed state"),
        SECRET_CANARY
    );
}

#[test]
fn canonical_state_write_replaces_existing_state_without_temporary_files() {
    let root = TestRoot::new();
    fs::create_dir_all(root.state_path().parent().expect("state parent"))
        .expect("create state parent");
    fs::write(
        root.state_path(),
        "{\n  \"version\": 1,\n  \"onboardingCompletedAt\": \"2026-03-15T02:30:00.000Z\"\n}\n",
    )
    .expect("write legacy state");

    root.materialize();

    let entries = fs::read_dir(root.state_path().parent().expect("state parent"))
        .expect("read state directory")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect state entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].file_name(), WORKSPACE_STATE_FILE);
}

#[test]
fn legacy_onboarding_completion_marker_is_canonicalized_without_bootstrap() {
    let root = TestRoot::new();
    let completed_at = "2026-03-15T02:30:00.000Z";
    fs::create_dir_all(root.state_path().parent().expect("state parent"))
        .expect("create state parent");
    fs::write(
        root.state_path(),
        format!("{{\n  \"version\": 1,\n  \"onboardingCompletedAt\": \"{completed_at}\"\n}}\n"),
    )
    .expect("write legacy state");

    let materialization = root.materialize();

    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Complete
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
    let state = state(&root);
    assert_eq!(state["setupCompletedAt"], completed_at);
    assert!(state.get("onboardingCompletedAt").is_none());
}

#[test]
fn existing_bootstrap_without_marker_is_recorded_as_pending_without_rewriting_it() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
        SECRET_CANARY,
    )
    .expect("write bootstrap");

    let materialization = root.materialize();

    assert_eq!(
        materialization.bootstrap(),
        WorkspaceBootstrapStatus::Pending
    );
    assert!(
        !materialization
            .initialized_files()
            .contains(&WorkspaceTemplateFile::Bootstrap)
    );
    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Bootstrap.file_name())
        )
        .expect("read bootstrap"),
        SECRET_CANARY
    );
    assert!(state(&root)["bootstrapSeededAt"].as_str().is_some());
}

#[test]
fn managed_template_migration_replaces_only_unchanged_upstream_files_idempotently() {
    let root = TestRoot::new();
    root.materialize();
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Identity.file_name()),
        SECRET_CANARY,
    )
    .expect("customize identity");

    AgentWorkspaceProjection::materialize(root.request_with_managed_templates())
        .expect("migrate managed templates");
    AgentWorkspaceProjection::materialize(root.request_with_managed_templates())
        .expect("repeat managed template migration");

    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Agents.file_name())
        )
        .expect("read migrated agents"),
        "managed AGENTS.md\n"
    );
    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Identity.file_name())
        )
        .expect("read customized identity"),
        SECRET_CANARY
    );
}

#[test]
fn context_merge_replaces_only_managed_section_and_preserves_user_content() {
    let root = TestRoot::new();
    root.materialize();
    let agents = root
        .workspace
        .join(WorkspaceTemplateFile::Agents.file_name());
    fs::write(&agents, format!("user heading\n\n{SECRET_CANARY}\n"))
        .expect("write user workspace content");
    fs::write(root.context.join("AGENTS.matchaclaw.md"), "first context")
        .expect("write first context");

    let first = AgentWorkspaceProjection::materialize(root.request_with_context())
        .expect("merge first context");
    fs::write(root.context.join("AGENTS.matchaclaw.md"), "updated context")
        .expect("update context");
    let second = AgentWorkspaceProjection::materialize(root.request_with_context())
        .expect("merge updated context");

    let content = fs::read_to_string(&agents).expect("read merged agents");
    assert_eq!(first.initialized_files(), []);
    assert_eq!(second.initialized_files(), []);
    assert!(content.contains("user heading"));
    assert!(content.contains(SECRET_CANARY));
    assert!(content.contains("updated context"));
    assert!(!content.contains("first context"));
}

#[test]
fn context_merge_removes_the_gateway_first_run_section_before_preserving_user_content() {
    let root = TestRoot::new();
    root.materialize();
    let agents = root
        .workspace
        .join(WorkspaceTemplateFile::Agents.file_name());
    fs::write(
        &agents,
        format!(
            "user heading\n\n## First Run\nopen this workspace and follow setup.\n\n{SECRET_CANARY}\n\n## Rules\nkeep this rule\n"
        ),
    )
    .expect("write gateway first-run content");
    fs::write(root.context.join("AGENTS.matchaclaw.md"), "managed context").expect("write context");

    AgentWorkspaceProjection::materialize(root.request_with_context()).expect("merge context");

    let content = fs::read_to_string(&agents).expect("read merged agents");
    assert!(content.contains("user heading"));
    assert!(content.contains(SECRET_CANARY));
    assert!(content.contains("## Rules\nkeep this rule"));
    assert!(content.contains("managed context"));
    assert!(!content.contains("## First Run"));
    assert!(!content.contains("open this workspace and follow setup"));
}

#[cfg(unix)]
#[test]
fn symlinked_workspace_or_template_is_rejected_without_writing_through() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    let target = root.path.join("outside-workspace");
    fs::create_dir_all(&target).expect("create outside workspace");
    symlink(&target, &root.workspace).expect("link workspace");

    let error = AgentWorkspaceProjection::materialize(root.request())
        .expect_err("symlinked workspace must be rejected");
    assert_eq!(error, WorkspaceProjectionError::WorkspaceUnavailable);
    assert!(
        !target
            .join(WorkspaceTemplateFile::Agents.file_name())
            .exists()
    );

    let root = TestRoot::new();
    fs::remove_file(
        root.templates
            .join(WorkspaceTemplateFile::Agents.file_name()),
    )
    .expect("remove template");
    symlink(
        root.path.join("outside-template"),
        root.templates
            .join(WorkspaceTemplateFile::Agents.file_name()),
    )
    .expect("link template");
    let error = AgentWorkspaceProjection::materialize(root.request())
        .expect_err("symlinked template must be rejected");
    assert_eq!(error, WorkspaceProjectionError::TemplateUnavailable);
}

#[test]
fn relative_and_escaping_workspace_inputs_are_rejected() {
    assert_eq!(
        AgentWorkspaceDirectory::try_new(PathBuf::from("relative-workspace")),
        Err(WorkspaceProjectionError::InvalidPath)
    );
    let escape = std::env::temp_dir()
        .join("workspace")
        .join("..")
        .join("escape");
    assert_eq!(
        WorkspaceTemplateDirectory::try_new(escape),
        Err(WorkspaceProjectionError::InvalidPath)
    );
}

#[test]
fn requests_and_errors_do_not_expose_private_paths_or_template_content() {
    let root = TestRoot::new();
    let request = root.request();
    let request_debug = format!("{request:?}");
    assert_eq!(
        request_debug,
        "AgentWorkspaceMaterializationRequest([REDACTED])"
    );
    assert!(!request_debug.contains(root.workspace.to_string_lossy().as_ref()));
    assert!(!request_debug.contains(root.templates.to_string_lossy().as_ref()));

    fs::remove_file(
        root.templates
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    )
    .expect("remove template");
    fs::write(
        root.templates
            .join(WorkspaceTemplateFile::Agents.file_name()),
        SECRET_CANARY,
    )
    .expect("overwrite template");
    let error = AgentWorkspaceProjection::materialize(root.request())
        .expect_err("missing template must fail");
    let rendered = format!("{error:?} {error}");
    assert_eq!(error, WorkspaceProjectionError::TemplateUnavailable);
    assert!(!rendered.contains(root.workspace.to_string_lossy().as_ref()));
    assert!(!rendered.contains(root.templates.to_string_lossy().as_ref()));
    assert!(!rendered.contains(SECRET_CANARY));
}
