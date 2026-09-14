use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

const MATCHA_IDENTITY: &str = "# IDENTITY.md\n\n- **名字：** Matcha\n";
const OPENCLAW_IDENTITY_TEMPLATE: &str = "# IDENTITY.md - Who Am I?\n\n_Fill this in during your first conversation. Make it yours._\n\n- **Name:**\n  _(pick something you like)_\n- **Emoji:**\n  _(your signature — pick one that feels right)_\n";
const SECRET_CANARY: &str = "workspace-private-content-canary";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
    workspace: PathBuf,
    templates: PathBuf,
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
            "openclaw-workspace-overlay-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        let templates = path.join("resources/agent-workspace-templates/main-agent");
        let context = path.join("resources/context");
        fs::create_dir_all(&templates).expect("create templates");
        fs::create_dir_all(&context).expect("create context");
        fs::write(
            templates.join(WorkspaceTemplateFile::Identity.file_name()),
            format!("---\ntitle: identity\n---\n{MATCHA_IDENTITY}"),
        )
        .expect("write identity template");
        Self {
            workspace: path.join("workspace"),
            templates,
            context,
            path,
        }
    }

    fn workspace(&self) -> AgentWorkspaceDirectory {
        AgentWorkspaceDirectory::try_new(self.workspace.clone()).expect("workspace path")
    }

    fn templates(&self) -> MatchaWorkspaceTemplateDirectory {
        MatchaWorkspaceTemplateDirectory::try_new(self.templates.clone()).expect("template path")
    }

    fn context(&self) -> WorkspaceContextDirectory {
        WorkspaceContextDirectory::try_new(self.context.clone()).expect("context path")
    }

    fn preseed_identity(&self) {
        MatchaWorkspaceOverlay::preseed_identity(self.workspace(), self.templates())
            .expect("preseed workspace identity");
    }

    fn write_template(&self, file: WorkspaceTemplateFile, content: &str) {
        fs::write(self.templates.join(file.file_name()), content).expect("write template");
    }

    fn write_main_agent_templates(&self) {
        self.write_template(WorkspaceTemplateFile::Agents, "# AGENTS.md\n");
        self.write_template(
            WorkspaceTemplateFile::Soul,
            "---\ntitle: soul\n---\n# SOUL.md\n",
        );
        self.write_template(WorkspaceTemplateFile::User, "# USER.md\n");
        self.write_template(WorkspaceTemplateFile::Heartbeat, "# HEARTBEAT.md\n");
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn assert_missing(path: &Path) {
    assert!(!path.exists(), "path must be absent");
}

#[test]
fn preseed_identity_creates_workspace_writes_matcha_identity_and_removes_bootstrap() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
        SECRET_CANARY,
    )
    .expect("write bootstrap");

    root.preseed_identity();

    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Identity.file_name())
        )
        .expect("read identity"),
        MATCHA_IDENTITY
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
}

#[test]
fn seed_main_agent_templates_writes_missing_template_files_and_removes_bootstrap() {
    let root = TestRoot::new();
    root.write_main_agent_templates();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
        SECRET_CANARY,
    )
    .expect("write bootstrap");

    MatchaWorkspaceOverlay::seed_main_agent_templates(root.workspace(), root.templates())
        .expect("seed main agent templates");

    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Agents.file_name())
        )
        .expect("read agents"),
        "# AGENTS.md\n"
    );
    assert_eq!(
        fs::read_to_string(root.workspace.join(WorkspaceTemplateFile::Soul.file_name()))
            .expect("read soul"),
        "# SOUL.md\n"
    );
    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Identity.file_name())
        )
        .expect("read identity"),
        MATCHA_IDENTITY
    );
    assert_eq!(
        fs::read_to_string(root.workspace.join(WorkspaceTemplateFile::User.file_name()))
            .expect("read user"),
        "# USER.md\n"
    );
    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Heartbeat.file_name())
        )
        .expect("read heartbeat"),
        "# HEARTBEAT.md\n"
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
}

#[test]
fn seed_main_agent_templates_preserves_existing_workspace_files() {
    let root = TestRoot::new();
    root.write_main_agent_templates();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Agents.file_name()),
        SECRET_CANARY,
    )
    .expect("write custom agents");

    MatchaWorkspaceOverlay::seed_main_agent_templates(root.workspace(), root.templates())
        .expect("seed main agent templates");

    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Agents.file_name())
        )
        .expect("read preserved agents"),
        SECRET_CANARY
    );
    assert_eq!(
        fs::read_to_string(root.workspace.join(WorkspaceTemplateFile::Soul.file_name()))
            .expect("read seeded soul"),
        "# SOUL.md\n"
    );
}

#[test]
fn preseed_identity_replaces_only_openclaw_native_identity_template() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Identity.file_name()),
        OPENCLAW_IDENTITY_TEMPLATE,
    )
    .expect("write OpenClaw identity template");

    root.preseed_identity();

    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Identity.file_name())
        )
        .expect("read replaced identity"),
        MATCHA_IDENTITY
    );

    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Identity.file_name()),
        SECRET_CANARY,
    )
    .expect("write custom identity");
    fs::write(
        root.workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
        SECRET_CANARY,
    )
    .expect("write bootstrap");

    root.preseed_identity();

    assert_eq!(
        fs::read_to_string(
            root.workspace
                .join(WorkspaceTemplateFile::Identity.file_name())
        )
        .expect("read preserved identity"),
        SECRET_CANARY
    );
    assert_missing(
        &root
            .workspace
            .join(WorkspaceTemplateFile::Bootstrap.file_name()),
    );
}

#[test]
fn context_merge_updates_only_matcha_section_and_preserves_first_run_content() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    let agents = root
        .workspace
        .join(WorkspaceTemplateFile::Agents.file_name());
    fs::write(
        &agents,
        format!(
            "user heading\n\n## First Run\nopen this workspace and follow setup.\n\n{SECRET_CANARY}\n"
        ),
    )
    .expect("write agents");
    fs::write(root.context.join("AGENTS.matchaclaw.md"), "first context").expect("write context");

    let first = MatchaWorkspaceOverlay::merge_context(root.workspace(), root.context())
        .expect("merge first context");
    fs::write(root.context.join("AGENTS.matchaclaw.md"), "updated context")
        .expect("update context");
    let second = MatchaWorkspaceOverlay::merge_context(root.workspace(), root.context())
        .expect("merge updated context");

    let content = fs::read_to_string(&agents).expect("read merged agents");
    assert_eq!(first.merged_files(), &["AGENTS.md".to_owned()]);
    assert_eq!(second.merged_files(), &["AGENTS.md".to_owned()]);
    assert_eq!(second.skipped_missing(), 0);
    assert!(content.contains("## First Run"));
    assert!(content.contains("open this workspace and follow setup."));
    assert!(content.contains(SECRET_CANARY));
    assert!(content.contains("updated context"));
    assert!(!content.contains("first context"));
}

#[test]
fn context_merge_skips_missing_targets_without_creating_workspace_files() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(root.context.join("SOUL.matchaclaw.md"), SECRET_CANARY).expect("write context");

    let merge = MatchaWorkspaceOverlay::merge_context(root.workspace(), root.context())
        .expect("merge context");

    assert!(merge.merged_files().is_empty());
    assert_eq!(merge.skipped_missing(), 1);
    assert_missing(&root.workspace.join(WorkspaceTemplateFile::Soul.file_name()));
}

#[test]
fn context_merge_ignores_retired_tools_context() {
    let root = TestRoot::new();
    fs::create_dir_all(&root.workspace).expect("create workspace");
    fs::write(root.context.join("TOOLS.matchaclaw.md"), SECRET_CANARY).expect("write context");

    let merge = MatchaWorkspaceOverlay::merge_context(root.workspace(), root.context())
        .expect("merge context");

    assert!(merge.merged_files().is_empty());
    assert_eq!(merge.skipped_missing(), 0);
    assert_missing(&root.workspace.join("TOOLS.md"));
}

#[cfg(unix)]
#[test]
fn symlinked_workspace_or_template_is_rejected_without_writing_through() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    let target = root.path.join("outside-workspace");
    fs::create_dir_all(&target).expect("create outside workspace");
    symlink(&target, &root.workspace).expect("link workspace");

    let error = MatchaWorkspaceOverlay::preseed_identity(root.workspace(), root.templates())
        .expect_err("symlinked workspace must be rejected");
    assert_eq!(error, WorkspaceProjectionError::WorkspaceUnavailable);
    assert_missing(&target.join(WorkspaceTemplateFile::Identity.file_name()));

    let root = TestRoot::new();
    fs::remove_file(
        root.templates
            .join(WorkspaceTemplateFile::Identity.file_name()),
    )
    .expect("remove template");
    symlink(
        root.path.join("outside-template"),
        root.templates
            .join(WorkspaceTemplateFile::Identity.file_name()),
    )
    .expect("link template");
    let error = MatchaWorkspaceOverlay::preseed_identity(root.workspace(), root.templates())
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
        MatchaWorkspaceTemplateDirectory::try_new(escape.clone()),
        Err(WorkspaceProjectionError::InvalidPath)
    );
    assert_eq!(
        WorkspaceContextDirectory::try_new(escape),
        Err(WorkspaceProjectionError::InvalidPath)
    );
}

#[test]
fn directory_debug_and_errors_do_not_expose_private_paths_or_template_content() {
    let root = TestRoot::new();
    let workspace = root.workspace();
    let templates = root.templates();
    let context = root.context();
    let rendered = format!("{workspace:?} {templates:?} {context:?}");
    assert!(!rendered.contains(root.workspace.to_string_lossy().as_ref()));
    assert!(!rendered.contains(root.templates.to_string_lossy().as_ref()));
    assert!(!rendered.contains(root.context.to_string_lossy().as_ref()));

    fs::remove_file(
        root.templates
            .join(WorkspaceTemplateFile::Identity.file_name()),
    )
    .expect("remove template");
    let error = MatchaWorkspaceOverlay::preseed_identity(root.workspace(), root.templates())
        .expect_err("missing template must fail");
    let rendered = format!("{error:?} {error}");
    assert_eq!(error, WorkspaceProjectionError::TemplateUnavailable);
    assert!(!rendered.contains(root.workspace.to_string_lossy().as_ref()));
    assert!(!rendered.contains(root.templates.to_string_lossy().as_ref()));
    assert!(!rendered.contains(SECRET_CANARY));
}
