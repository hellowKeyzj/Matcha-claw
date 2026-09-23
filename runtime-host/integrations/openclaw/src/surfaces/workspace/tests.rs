use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::json;

use super::{
    OpenClawWorkspaceAccess, WorkspaceReadFailure,
    access::{MAX_BINARY_BYTES, MAX_TEXT_BYTES, WorkspaceFileError, WorkspaceFiles},
    media::{WorkspaceMedia, WorkspaceMediaFailure, WorkspaceMediaPath},
    selection::OpenClawWorkspaceSelector,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

const ONE_PIXEL_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0,
    0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1,
    39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
const ONE_PIXEL_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>"#;
const ONE_PIXEL_SVG_BASE64: &str = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=";
const ONE_PIXEL_SVG_DATA_URL: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=";

struct FixtureRoot(PathBuf);

impl FixtureRoot {
    fn new() -> Self {
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let name = format!("openclaw-workspace-files-{}-{sequence}", std::process::id());
        #[cfg(unix)]
        let path = PathBuf::from("/tmp").join(name);
        #[cfg(not(unix))]
        let path = std::env::temp_dir().join(name);
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn files(workspace: &Path, allow_root: &Path) -> WorkspaceFiles {
    let selector = OpenClawWorkspaceSelector::new(
        allow_root,
        &json!({
            "agents": { "list": [{ "id": "reviewer", "workspace": workspace }] }
        }),
    )
    .unwrap();
    WorkspaceFiles::new(
        selector
            .select("agent:reviewer:workspace-files")
            .expect("configured reviewer"),
    )
}

#[test]
fn selects_the_main_workspace_from_default_then_main_or_default_agent_configuration() {
    let root = FixtureRoot::new();
    let config_directory = root.path().join("openclaw");
    let default_workspace = root.path().join("default-workspace");
    let main_workspace = root.path().join("main-workspace");
    let reviewer_workspace = root.path().join("reviewer-workspace");
    let selector = OpenClawWorkspaceSelector::new(
        &config_directory,
        &json!({
            "agents": {
                "defaults": { "workspace": default_workspace },
                "list": [
                    { "id": "main", "workspace": main_workspace },
                    { "id": "reviewer", "workspace": reviewer_workspace }
                ]
            }
        }),
    )
    .unwrap();

    assert_eq!(
        selector
            .select("agent:main:session-1")
            .expect("main agent")
            .as_path(),
        default_workspace
    );
    assert_eq!(
        selector
            .select("agent:reviewer:session-1")
            .expect("configured agent")
            .as_path(),
        reviewer_workspace
    );
}

#[test]
fn selects_agent_workspaces_from_entries_configuration() {
    let root = FixtureRoot::new();
    let config_directory = root.path().join("openclaw");
    let reviewer_workspace = root.path().join("reviewer-workspace");
    let selector = OpenClawWorkspaceSelector::new(
        &config_directory,
        &json!({
            "agents": {
                "entries": {
                    "reviewer": { "workspace": reviewer_workspace }
                }
            }
        }),
    )
    .unwrap();

    assert_eq!(
        selector
            .select("agent:reviewer:session-1")
            .expect("configured agent")
            .as_path(),
        reviewer_workspace
    );
}

#[test]
fn excludes_teambuddy_workspaces_from_maintenance_roots() {
    let root = FixtureRoot::new();
    let config_directory = root.path().join("openclaw");
    let selector = OpenClawWorkspaceSelector::new(
        &config_directory,
        &json!({
            "agents": {
                "defaults": { "workspace": config_directory.join("workspace") },
                "list": [
                    { "id": "team-buddy", "workspace": config_directory.join("teambuddy").join("team-a") },
                    { "id": "reviewer", "workspace": root.path().join("reviewer-workspace") }
                ]
            }
        }),
    )
    .unwrap();

    assert_eq!(
        selector.maintenance_roots(),
        [
            config_directory.join("workspace"),
            root.path().join("reviewer-workspace"),
        ]
    );

    let teambuddy_root = OpenClawWorkspaceSelector::new(
        &config_directory,
        &json!({
            "agents": { "defaults": { "workspace": config_directory.join("teambuddy") } }
        }),
    )
    .unwrap();
    assert!(teambuddy_root.maintenance_roots().is_empty());
}

#[test]
fn maintenance_directories_follow_configured_roots_despite_unrelated_secret_bearing_config() {
    let root = FixtureRoot::new();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    let config_directory = state_dir.as_path();
    let default_workspace = root.path().join("default-workspace");
    let reviewer_workspace = root.path().join("reviewer-workspace");
    fs::write(
        config_directory.join("openclaw.json"),
        serde_json::to_vec(&json!({
            "gateway": { "auth": { "token": "workspace-secret-canary" } },
            "models": { "providers": { "openai": { "apiKey": "workspace-secret-canary" } } },
            "agents": {
                "defaults": { "workspace": default_workspace },
                "list": [{ "id": "reviewer", "workspace": reviewer_workspace }]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let directories = OpenClawWorkspaceAccess::new(state_dir)
        .maintenance_workspace_directories()
        .unwrap();

    assert_eq!(
        directories
            .iter()
            .map(|directory| directory.as_str())
            .collect::<Vec<_>>(),
        [
            default_workspace.to_str().unwrap(),
            reviewer_workspace.to_str().unwrap(),
        ]
    );
}

#[test]
fn maintenance_directories_follow_configured_roots_and_exclude_teambuddy() {
    let root = FixtureRoot::new();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    let config_directory = state_dir.as_path();
    let default_workspace = root.path().join("default-workspace");
    let reviewer_workspace = root.path().join("reviewer-workspace");
    fs::write(
        config_directory.join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {
                "defaults": { "workspace": default_workspace },
                "list": [
                    { "id": "reviewer", "workspace": reviewer_workspace },
                    { "id": "team-buddy", "workspace": config_directory.join("teambuddy").join("team-a") }
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let directories = OpenClawWorkspaceAccess::new(state_dir)
        .maintenance_workspace_directories()
        .unwrap();

    assert_eq!(
        directories
            .iter()
            .map(|directory| directory.as_str())
            .collect::<Vec<_>>(),
        [
            default_workspace.to_str().unwrap(),
            reviewer_workspace.to_str().unwrap(),
        ]
    );
    assert!(!format!("{directories:?}").contains("reviewer-workspace"));
}

#[test]
fn unknown_agents_use_the_legacy_workspace_subagents_fallback() {
    let root = FixtureRoot::new();
    let config_directory = root.path().join("openclaw");
    let selector = OpenClawWorkspaceSelector::new(&config_directory, &json!({})).unwrap();

    assert_eq!(
        selector
            .select("agent:ui-designer:session-1")
            .expect("unknown agent fallback")
            .as_path(),
        config_directory.join("workspace-subagents/ui-designer")
    );
    assert_eq!(
        selector
            .select("agent:Design Review!:session-1")
            .expect("slugged unknown agent fallback")
            .as_path(),
        config_directory.join("workspace-subagents/design-review")
    );
    assert_eq!(
        selector
            .select("agent:42:session-1")
            .expect("numeric unknown agent fallback")
            .as_path(),
        config_directory.join("workspace-subagents/agent")
    );
}

#[test]
fn expands_home_workspace_paths_before_selection() {
    let root = FixtureRoot::new();
    let config_directory = root.path().join("openclaw");
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let Some(home) = home else {
        return;
    };
    let selector = OpenClawWorkspaceSelector::new(
        &config_directory,
        &json!({ "agents": { "defaults": { "workspace": "~/legacy-workspace" } } }),
    )
    .unwrap();

    assert_eq!(
        selector.select("agent:main:session-1").unwrap().as_path(),
        PathBuf::from(home).join("legacy-workspace")
    );
}

#[test]
fn selects_configured_agents_and_unknown_fallbacks() {
    let root = FixtureRoot::new();
    let config_directory = root.path().join("openclaw");
    let reviewer_workspace = root.path().join("reviewer-workspace");
    let selector = OpenClawWorkspaceSelector::new(
        &config_directory,
        &json!({
            "agents": {
                "list": [{ "id": "reviewer", "workspace": reviewer_workspace }]
            }
        }),
    )
    .unwrap();

    assert_eq!(
        selector
            .select("agent:reviewer:session-1")
            .expect("configured agent")
            .as_path(),
        reviewer_workspace
    );
    assert_eq!(
        selector
            .select("agent:42:session-1")
            .expect("unknown agent fallback")
            .as_path(),
        config_directory.join("workspace-subagents/agent")
    );
    assert_eq!(
        selector
            .select("agent:Design Review!:session-1")
            .expect("unknown agent fallback")
            .as_path(),
        config_directory.join("workspace-subagents/design-review")
    );
    assert_eq!(
        selector
            .select("agent:reviewer")
            .expect("configured agent")
            .as_path(),
        reviewer_workspace
    );
}

#[test]
fn workspace_access_reads_from_the_session_selected_root_with_a_bounded_receipt() {
    let root = FixtureRoot::new();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    let reviewer_workspace = root.path().join("reviewer-workspace");
    fs::create_dir(&reviewer_workspace).unwrap();
    fs::create_dir(reviewer_workspace.join("docs")).unwrap();
    fs::write(
        reviewer_workspace.join("docs").join("notes.txt"),
        "review notes",
    )
    .unwrap();
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {"list": [{"id": "reviewer", "workspace": reviewer_workspace}]}
        }))
        .unwrap(),
    )
    .unwrap();
    let access = OpenClawWorkspaceAccess::new(state_dir);

    let receipt = access
        .read_text("agent:reviewer:session-1", "docs/notes.txt", MAX_TEXT_BYTES)
        .unwrap();

    assert_eq!(receipt.name(), "docs/notes.txt");
    assert_eq!(receipt.content(), "review notes");
    assert_eq!(receipt.size(), 12);
    assert_eq!(
        access.read_text("agent:reviewer:session-1", "../secret", MAX_TEXT_BYTES,),
        Err(WorkspaceReadFailure::InvalidPath)
    );
    let output = format!("{access:?} {receipt:?}");
    assert!(!output.contains("reviewer-workspace"));
    assert!(!output.contains("review notes"));
}

#[test]
fn trusted_workspace_directory_uses_the_session_selected_workspace_and_redacts_it() {
    let root = FixtureRoot::new();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    let default_workspace = root.path().join("default-workspace");
    let reviewer_workspace = root.path().join("reviewer-workspace");
    fs::create_dir(&default_workspace).unwrap();
    fs::create_dir(&reviewer_workspace).unwrap();
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {
                "defaults": { "workspace": default_workspace },
                "list": [{ "id": "reviewer", "workspace": reviewer_workspace }]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let unknown_workspace = state_dir
        .as_path()
        .join("workspace-subagents")
        .join("unknown");
    let access = OpenClawWorkspaceAccess::new(state_dir);

    let reviewer = access
        .trusted_workspace_directory("agent:reviewer:session-1")
        .unwrap();
    let main = access
        .trusted_workspace_directory("agent:main:session-1")
        .unwrap();

    assert_eq!(reviewer.as_str(), reviewer_workspace.to_str().unwrap());
    assert_eq!(main.as_str(), default_workspace.to_str().unwrap());
    let unknown = access
        .trusted_workspace_directory("agent:unknown:session-1")
        .unwrap();
    assert_eq!(unknown.as_str(), unknown_workspace.to_str().unwrap());
    let output = format!("{reviewer:?} {unknown:?}");
    assert!(!output.contains("reviewer-workspace"));
}

#[cfg(unix)]
#[test]
fn trusted_workspace_directory_rejects_non_utf8_selected_paths() {
    use std::os::unix::ffi::OsStringExt;

    let root = FixtureRoot::new();
    let state_dir = platform::state_dir::CanonicalStateDir::provision(
        root.path()
            .join(std::ffi::OsString::from_vec(b"state-\xff".to_vec())),
    )
    .unwrap();
    fs::write(state_dir.as_path().join("openclaw.json"), "{}").unwrap();
    let access = OpenClawWorkspaceAccess::new(state_dir);

    assert_eq!(
        access.trusted_workspace_directory("agent:main:session-1"),
        Err(super::WorkspaceDirectoryFailure::Unavailable)
    );
}

#[test]
fn workspace_access_reads_binary_and_stats_selected_root_without_projecting_the_root() {
    let root = FixtureRoot::new();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    let workspace = root.path().join("reviewer-workspace");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(workspace.join("docs")).unwrap();
    fs::write(workspace.join("docs").join("asset.bin"), [0_u8, 1, 2, 3]).unwrap();
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {"list": [{"id": "reviewer", "workspace": workspace}]}
        }))
        .unwrap(),
    )
    .unwrap();
    let access = OpenClawWorkspaceAccess::new(state_dir);

    let binary = access
        .read_binary("agent:reviewer:session-1", "docs/asset.bin", 4)
        .unwrap();
    let directory = access.stat("agent:reviewer:session-1", "docs").unwrap();
    assert_eq!(binary.name(), "docs/asset.bin");
    assert_eq!(binary.content(), [0, 1, 2, 3]);
    assert_eq!(binary.size(), 4);
    assert_eq!(directory.name(), "docs");
    assert!(directory.is_directory());
    assert_eq!(directory.size(), 0);
    assert!(matches!(
        access.read_binary("agent:reviewer:session-1", "docs/asset.bin", 3),
        Err(super::WorkspaceBinaryFailure::TooLarge)
    ));
    assert!(matches!(
        access.stat("agent:reviewer:session-1", "../secret"),
        Err(super::WorkspaceStatFailure::InvalidPath)
    ));
    let output = format!("{access:?} {binary:?} {directory:?}");
    assert!(!output.contains("reviewer-workspace"));
    assert!(!output.contains("[0, 1, 2, 3]"));
}

#[test]
fn stat_projects_the_file_modification_time() {
    use std::time::UNIX_EPOCH;

    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let path = workspace.join("notes.txt");
    fs::write(&path, "before").unwrap();
    let expected: u64 = fs::metadata(&path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();

    assert_eq!(
        files(&workspace, root.path())
            .stat("notes.txt")
            .unwrap()
            .mtime_ms,
        expected
    );
}

#[test]
fn preserves_text_and_binary_bounds_and_file_kind_failures() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(workspace.join("folder")).unwrap();
    fs::write(workspace.join("binary.txt"), b"text\0binary").unwrap();
    fs::write(
        workspace.join("too-large.txt"),
        vec![b'x'; MAX_TEXT_BYTES + 1],
    )
    .unwrap();
    let binary_file = fs::File::create(workspace.join("too-large.bin")).unwrap();
    binary_file.set_len(MAX_BINARY_BYTES as u64 + 1).unwrap();
    let files = files(&workspace, root.path());

    assert!(matches!(
        files.read_text_with_limit("binary.txt", MAX_TEXT_BYTES),
        Err(WorkspaceFileError::Binary)
    ));
    assert!(matches!(
        files.read_text_with_limit("too-large.txt", MAX_TEXT_BYTES),
        Err(WorkspaceFileError::TooLarge)
    ));
    assert!(matches!(
        files.read_binary("too-large.bin", MAX_BINARY_BYTES),
        Err(WorkspaceFileError::TooLarge)
    ));
    assert!(matches!(
        files.read_binary("folder", MAX_BINARY_BYTES),
        Err(WorkspaceFileError::NotFile)
    ));
    assert_eq!(
        files.list_dir_with_options("binary.txt", false),
        Err(WorkspaceFileError::NotDirectory)
    );
}

#[test]
fn workspace_media_receipts_are_session_fenced_one_shot_and_redacted() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace-secret-canary");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("artifact.png"), ONE_PIXEL_PNG).unwrap();
    let media = WorkspaceMedia::new();
    let files = files(&workspace, root.path());

    let receipt = media
        .prepare(
            "agent:reviewer:session-1",
            &files,
            "artifact.png",
            "image/png",
        )
        .unwrap();
    assert!(receipt.handle().as_str().starts_with("media_"));
    assert_eq!(receipt.name(), "artifact.png");
    assert_eq!(receipt.mime_type(), "image/png");
    assert_eq!(receipt.size(), ONE_PIXEL_PNG.len() as u64);
    assert_eq!(receipt.preview(), Some(ONE_PIXEL_PNG_DATA_URL));
    assert!(matches!(
        media.resolve("agent:reviewer:session-2", receipt.handle().as_str()),
        Err(WorkspaceMediaFailure::Unavailable)
    ));
    assert_eq!(
        media
            .resolve("agent:reviewer:session-1", receipt.handle().as_str())
            .unwrap()
            .content(),
        ONE_PIXEL_PNG
    );
    assert!(matches!(
        media.resolve("agent:reviewer:session-1", receipt.handle().as_str()),
        Err(WorkspaceMediaFailure::Unavailable)
    ));
    let output = format!("{receipt:?}");
    assert!(!output.contains("workspace-secret-canary"));
    assert!(!output.contains(receipt.handle().as_str()));
}

#[test]
fn workspace_media_rejects_mismatched_image_content() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("artifact.png"), b"not a png").unwrap();
    let media = WorkspaceMedia::new();
    let files = files(&workspace, root.path());

    assert_eq!(
        media.prepare(
            "agent:reviewer:session-1",
            &files,
            "artifact.png",
            "image/png",
        ),
        Err(WorkspaceMediaFailure::Unavailable)
    );
}

#[test]
fn workspace_media_keeps_opaque_binary_content_without_image_sniffing() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("artifact.bin"), [0_u8, 1, 2, 3]).unwrap();
    let media = WorkspaceMedia::new();
    let files = files(&workspace, root.path());

    let receipt = media
        .prepare(
            "agent:reviewer:session-1",
            &files,
            "artifact.bin",
            "application/octet-stream",
        )
        .unwrap();
    assert_eq!(receipt.mime_type(), "application/octet-stream");
    assert_eq!(receipt.preview(), None);
}

#[test]
fn workspace_media_supports_thumbnail_batches_and_bounded_buffer_staging() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("artifact.png"), ONE_PIXEL_PNG).unwrap();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {"list": [{"id": "reviewer", "workspace": workspace}]}
        }))
        .unwrap(),
    )
    .unwrap();
    let access = OpenClawWorkspaceAccess::new(state_dir);

    let paths = vec![WorkspaceMediaPath::new(
        "asset-key".into(),
        "artifact.png".into(),
        "image/png".into(),
    )];
    let thumbnails = access
        .thumbnails_media("agent:reviewer:workspace-files", &paths)
        .unwrap();
    let media = WorkspaceMedia::new();
    assert_eq!(thumbnails.len(), 1);
    assert_eq!(thumbnails[0].key(), "asset-key");
    assert_eq!(
        thumbnails[0].thumbnail().file_size(),
        ONE_PIXEL_PNG.len() as u64,
    );
    assert_eq!(
        thumbnails[0].thumbnail().preview(),
        Some(ONE_PIXEL_PNG_DATA_URL),
    );

    let receipt = media
        .stage_buffer(
            "agent:reviewer:workspace-files",
            ONE_PIXEL_PNG_BASE64,
            "buffer.png",
            "image/png",
        )
        .unwrap();
    assert_eq!(receipt.name(), "buffer.png");
    assert_eq!(receipt.size(), ONE_PIXEL_PNG.len() as u64);
    assert_eq!(
        media
            .resolve("agent:reviewer:workspace-files", receipt.handle().as_str())
            .unwrap()
            .content(),
        ONE_PIXEL_PNG
    );
}

#[test]
fn workspace_media_supports_svg_previews() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("artifact.svg"), ONE_PIXEL_SVG).unwrap();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    fs::create_dir_all(state_dir.as_path().join("media/outgoing/records")).unwrap();
    fs::write(
        state_dir
            .as_path()
            .join("media/outgoing/records/svg-asset.json"),
        serde_json::to_vec(&json!({
            "sessionIdentity": {
                "agentId": "reviewer",
                "sessionKey": "agent:reviewer:workspace-files"
            },
            "original": {
                "path": workspace.join("artifact.svg"),
                "contentType": "image/svg+xml"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let media = WorkspaceMedia::new();
    let files = files(&workspace, root.path());

    let receipt = media
        .prepare(
            "agent:reviewer:workspace-files",
            &files,
            "artifact.svg",
            "image/svg+xml",
        )
        .unwrap();
    assert_eq!(receipt.mime_type(), "image/svg+xml");
    assert_eq!(receipt.preview(), Some(ONE_PIXEL_SVG_DATA_URL));
    assert_eq!(
        media
            .resolve("agent:reviewer:workspace-files", receipt.handle().as_str())
            .unwrap()
            .content(),
        ONE_PIXEL_SVG
    );

    let thumbnail = media
        .thumbnail(&files, "artifact.svg", "image/svg+xml")
        .unwrap();
    assert_eq!(thumbnail.file_size(), ONE_PIXEL_SVG.len() as u64);
    assert_eq!(thumbnail.preview(), Some(ONE_PIXEL_SVG_DATA_URL));

    let receipt = media
        .stage_buffer(
            "agent:reviewer:workspace-files",
            ONE_PIXEL_SVG_BASE64,
            "buffer.svg",
            "image/svg+xml",
        )
        .unwrap();
    assert_eq!(receipt.mime_type(), "image/svg+xml");
    assert_eq!(receipt.preview(), Some(ONE_PIXEL_SVG_DATA_URL));

    let thumbnail = media
        .thumbnail_gateway(
            &state_dir,
            "agent:reviewer:workspace-files",
            "http://localhost/api/chat/media/outgoing/owner/svg-asset/artifact.svg",
            "reviewer",
            "image/svg+xml",
        )
        .unwrap();
    assert_eq!(thumbnail.file_size(), ONE_PIXEL_SVG.len() as u64);
    assert_eq!(thumbnail.preview(), Some(ONE_PIXEL_SVG_DATA_URL));
}

#[test]
fn workspace_media_rejects_invalid_base64_and_image_mime() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let media = WorkspaceMedia::new();
    let files = files(&workspace, root.path());

    assert!(matches!(
        media.stage_buffer(
            "agent:reviewer:workspace-files",
            "not-base64!",
            "file.bin",
            "application/octet-stream",
        ),
        Err(WorkspaceMediaFailure::Unavailable)
    ));
    assert!(matches!(
        media.thumbnail(&files, "missing.png", "image/png"),
        Err(WorkspaceMediaFailure::Unavailable | WorkspaceMediaFailure::NotFile)
    ));
}

#[test]
fn workspace_media_rejects_invalid_references_and_root_escape() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let media = WorkspaceMedia::new();
    let files = files(&workspace, root.path());

    assert!(matches!(
        media.prepare(
            "agent:reviewer:session-1",
            &files,
            "../outside.png",
            "image/png"
        ),
        Err(WorkspaceMediaFailure::InvalidPath)
    ));
    assert!(matches!(
        media.resolve("agent:reviewer:session-1", "not-a-media-reference"),
        Err(WorkspaceMediaFailure::InvalidReference)
    ));
    assert!(matches!(
        media.resolve(
            "agent:reviewer:session-1",
            "media_ABCDEF0123456789ABCDEF0123456789"
        ),
        Err(WorkspaceMediaFailure::Unavailable)
    ));
}

#[test]
fn rejects_traversal_and_does_not_derive_a_root_from_the_current_directory() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let files = files(&workspace, root.path());

    for path in [
        "",
        ".",
        "..",
        "../secret",
        "nested//file",
        r"nested\\file",
        "/etc/passwd",
        r"C:\Windows\system32",
        "C:relative",
    ] {
        assert!(matches!(
            files.read_text_with_limit(path, MAX_TEXT_BYTES),
            Err(WorkspaceFileError::InvalidRelative)
        ));
    }
}

#[test]
fn lists_rooted_directory_receipts_with_legacy_filters() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    let folder = workspace.join("folder");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&folder).unwrap();
    for name in [
        "child-dir",
        "node_modules",
        ".venv",
        "__pycache__",
        "dist",
        "build",
        ".git",
        ".hidden",
    ] {
        fs::create_dir(folder.join(name)).unwrap();
    }
    fs::write(workspace.join("AGENTS.md"), "workspace instructions").unwrap();
    fs::write(folder.join(".hidden.txt"), "hidden").unwrap();
    fs::write(folder.join("zeta.txt"), "z").unwrap();
    fs::write(folder.join("alpha.txt"), "a").unwrap();
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {"list": [{"id": "reviewer", "workspace": workspace}]}
        }))
        .unwrap(),
    )
    .unwrap();
    let access = OpenClawWorkspaceAccess::new(state_dir);

    let entries = access
        .list_dir_with_options("agent:reviewer:workspace-files", "", false)
        .expect("workspace root listing must return entries");
    assert_eq!(
        entries
            .entries()
            .iter()
            .map(|entry| (
                entry.relative_path(),
                entry.display(),
                entry.is_directory(),
                entry.size()
            ))
            .collect::<Vec<_>>(),
        [
            ("folder", "folder", true, 0),
            ("AGENTS.md", "AGENTS.md", false, 22),
        ]
    );

    let entries = access
        .list_dir_with_options("agent:reviewer:workspace-files", "folder", false)
        .unwrap();
    assert_eq!(
        entries
            .entries()
            .iter()
            .map(|entry| (
                entry.relative_path(),
                entry.display(),
                entry.is_directory(),
                entry.size()
            ))
            .collect::<Vec<_>>(),
        [
            ("folder/child-dir", "child-dir", true, 0),
            ("folder/alpha.txt", "alpha.txt", false, 1),
            ("folder/zeta.txt", "zeta.txt", false, 1),
        ]
    );

    let entries = access
        .list_dir_with_options("agent:reviewer:workspace-files", "folder", true)
        .unwrap();
    assert_eq!(
        entries
            .entries()
            .iter()
            .map(|entry| entry.display())
            .collect::<Vec<_>>(),
        [
            ".hidden",
            "child-dir",
            ".hidden.txt",
            "alpha.txt",
            "zeta.txt"
        ]
    );
}

#[test]
fn does_not_silently_drop_directory_entries_above_the_legacy_transport_bound() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    for index in 0..300 {
        fs::write(workspace.join(format!("file-{index:03}.txt")), "x").unwrap();
    }
    let state_dir =
        platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&json!({
            "agents": {"list": [{"id": "reviewer", "workspace": workspace}]}
        }))
        .unwrap(),
    )
    .unwrap();
    let access = OpenClawWorkspaceAccess::new(state_dir);

    let entries = access
        .list_dir_with_options("agent:reviewer:workspace-files", "", false)
        .unwrap();

    assert_eq!(entries.entries().len(), 300);
    assert_eq!(entries.entries().first().unwrap().display(), "file-000.txt");
    assert_eq!(entries.entries().last().unwrap().display(), "file-299.txt");
}

#[test]
fn writes_bounded_text_by_atomic_replacement_inside_selected_workspace() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(workspace.join("docs")).unwrap();
    fs::write(workspace.join("docs").join("note.txt"), "old text").unwrap();
    let files = files(&workspace, root.path());

    let receipt = files.write_text("docs/note.txt", "new text").unwrap();

    assert_eq!(receipt.name, "docs/note.txt");
    assert_eq!(receipt.size, 8);
    assert_eq!(
        fs::read_to_string(workspace.join("docs").join("note.txt")).unwrap(),
        "new text"
    );
    files
        .write_text("nested/new/note.txt", "new nested text")
        .unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join("nested/new/note.txt")).unwrap(),
        "new nested text"
    );
}

#[test]
fn write_text_rejects_escape_and_oversized_content_without_creating_files() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let files = files(&workspace, root.path());

    assert!(matches!(
        files.write_text("../outside.txt", "blocked"),
        Err(WorkspaceFileError::InvalidRelative)
    ));
    assert!(matches!(
        files.write_text("too-large.txt", &"x".repeat(MAX_TEXT_BYTES + 1)),
        Err(WorkspaceFileError::TooLarge)
    ));
    assert!(!workspace.join("outside.txt").exists());
    assert!(!workspace.join("too-large.txt").exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_components_and_leaves_without_following_foreign_targets() {
    use std::os::unix::fs::symlink;

    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    let target = root.path().join("foreign");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(target.join("private.txt"), "private target").unwrap();
    symlink(&target, workspace.join("linked-dir")).unwrap();
    symlink(target.join("private.txt"), workspace.join("link.txt")).unwrap();
    let files = files(&workspace, root.path());

    for result in [
        files
            .read_text_with_limit("linked-dir/private.txt", MAX_TEXT_BYTES)
            .map(|_| ()),
        files
            .read_text_with_limit("link.txt", MAX_TEXT_BYTES)
            .map(|_| ()),
        files.stat("linked-dir/private.txt").map(|_| ()),
        files.list_dir_with_options("linked-dir", false).map(|_| ()),
    ] {
        assert_eq!(result, Err(WorkspaceFileError::Unavailable));
    }
    assert_eq!(
        files.write_text("linked-dir/private.txt", "overwritten"),
        Err(WorkspaceFileError::Unavailable)
    );
    assert_eq!(
        fs::read_to_string(target.join("private.txt")).unwrap(),
        "private target"
    );
}

#[cfg(windows)]
#[test]
fn rejects_reparse_point_components_without_following_foreign_targets() {
    use std::{
        os::windows::fs::MetadataExt,
        process::{Command, Stdio},
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace");
    let target = root.path().join("foreign");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(target.join("private.txt"), "private target").unwrap();
    let link = workspace.join("linked-dir");
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run mklink junction fixture");
    assert!(status.success(), "create Windows junction fixture");
    assert_ne!(
        fs::symlink_metadata(&link)
            .expect("junction metadata")
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT,
        0,
        "fixture must be a Windows reparse point"
    );
    let files = files(&workspace, root.path());

    for result in [
        files
            .read_text_with_limit("linked-dir/private.txt", MAX_TEXT_BYTES)
            .map(|_| ()),
        files.stat("linked-dir/private.txt").map(|_| ()),
        files.list_dir_with_options("linked-dir", false).map(|_| ()),
    ] {
        assert_eq!(result, Err(WorkspaceFileError::Unavailable));
    }
    assert_eq!(
        fs::read_to_string(target.join("private.txt")).unwrap(),
        "private target"
    );
}

#[test]
fn redacts_the_selected_workspace_from_errors_and_debug_output() {
    let root = FixtureRoot::new();
    let workspace = root.path().join("workspace-secret-canary");
    fs::create_dir(&workspace).unwrap();
    let files = files(&workspace, root.path());
    let error = files
        .read_text_with_limit("missing.txt", MAX_TEXT_BYTES)
        .unwrap_err();
    let output = format!("{files:?} {error:?} {error}");

    assert!(!output.contains("workspace-secret-canary"));
    assert!(!output.contains(&root.path().display().to_string()));
}
