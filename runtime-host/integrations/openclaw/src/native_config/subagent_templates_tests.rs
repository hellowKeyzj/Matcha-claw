use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

#[test]
fn catalog_projects_only_discovered_regular_templates_and_public_fields() {
    let root = TestRoot::new();
    root.write(
        "catalog.json",
        r#"{
        "categories": [{"id": "design", "order": 10}, {"id": "unused", "order": 1}],
        "templates": [
            {"id": "brand-guardian", "categoryId": "design", "order": 2},
            {"id": "plain-agent", "order": 1}
        ]
    }"#,
    );
    root.write(
        "brand-guardian/MEMORY.md",
        "# Brand Guardian\nProtect the brand.\n",
    );
    root.write("brand-guardian/AGENTS.md", "Brand rules.");
    root.write("plain-agent/AGENTS.md", "Plain guidance.");
    root.write("ignored/README.md", "Not a template.");

    let catalog = SubagentTemplateCatalog::list(&root.directory()).unwrap();

    assert_eq!(catalog.categories().len(), 1);
    assert_eq!(catalog.categories()[0].id, "design");
    assert_eq!(catalog.templates().len(), 2);
    assert_eq!(catalog.templates()[0].id, "plain-agent");
    assert_eq!(catalog.templates()[1].id, "brand-guardian");
    assert_eq!(catalog.templates()[1].name, "Brand Guardian");
    assert_eq!(
        catalog.templates()[1].summary.as_deref(),
        Some("Protect the brand.")
    );
    assert_eq!(
        serde_json::to_value(&catalog).unwrap(),
        serde_json::json!({
            "categories": [{"id": "design", "order": 10}],
            "templates": [
                {"id": "plain-agent", "name": "Plain Agent", "summary": "Plain guidance.", "order": 1, "files": ["AGENTS.md"]},
                {"id": "brand-guardian", "name": "Brand Guardian", "summary": "Protect the brand.", "categoryId": "design", "order": 2, "files": ["AGENTS.md", "MEMORY.md"]}
            ]
        })
    );
}

#[test]
fn malformed_catalog_falls_back_to_discovered_template_without_metadata() {
    let root = TestRoot::new();
    root.write("catalog.json", "not valid json");
    root.write("operator/AGENTS.md", "Operate safely.");

    let catalog = SubagentTemplateCatalog::list(&root.directory()).unwrap();

    assert!(catalog.categories().is_empty());
    assert_eq!(catalog.templates().len(), 1);
    assert_eq!(catalog.templates()[0].id, "operator");
    assert_eq!(
        catalog.templates()[0].summary.as_deref(),
        Some("Operate safely.")
    );
    assert_eq!(catalog.templates()[0].category_id, None);
}

#[test]
fn detail_is_limited_to_discovered_template_and_allowed_regular_files() {
    let root = TestRoot::new();
    root.write("brand-guardian/AGENTS.md", "Guard the brand.");
    root.write("brand-guardian/MEMORY.md", "Remember durable context.");
    root.write("brand-guardian/TOOLS.md", "Use tools carefully.");
    root.write("brand-guardian/IDENTITY.md", "Brand Guardian");
    root.write("brand-guardian/private.txt", "Must not be public.");

    let detail = SubagentTemplateCatalog::detail(&root.directory(), "brand-guardian").unwrap();
    let serialized = serde_json::to_value(&detail).unwrap();

    assert_eq!(serialized["template"]["id"], "brand-guardian");
    assert_eq!(
        serialized["template"]["fileContents"]["AGENTS.md"],
        "Guard the brand."
    );
    assert_eq!(
        serialized["template"]["fileContents"]["MEMORY.md"],
        "Remember durable context."
    );
    assert!(
        serialized["template"]["fileContents"]
            .get("TOOLS.md")
            .is_none()
    );
    assert!(
        serialized["template"]["fileContents"]
            .get("private.txt")
            .is_none()
    );
    assert_eq!(
        SubagentTemplateCatalog::detail(&root.directory(), "../brand-guardian"),
        Err(SubagentTemplateError::NotFound)
    );
    assert_eq!(
        SubagentTemplateCatalog::detail(&root.directory(), "missing"),
        Err(SubagentTemplateError::NotFound)
    );
}

#[cfg(unix)]
#[test]
fn symlinked_root_and_template_files_are_unavailable() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    let target = TestRoot::new();
    target.write("agent/AGENTS.md", "Target.");
    let linked_root = root.path.join("linked-root");
    symlink(&target.path, &linked_root).unwrap();
    assert_eq!(
        SubagentTemplateCatalog::list(&SubagentTemplateDirectory::try_new(linked_root).unwrap()),
        Err(SubagentTemplateError::Unavailable)
    );

    root.write("agent/AGENTS.md", "Regular.");
    symlink(
        root.path.join("agent/AGENTS.md"),
        root.path.join("agent/SOUL.md"),
    )
    .unwrap();
    assert_eq!(
        SubagentTemplateCatalog::list(&root.directory()),
        Err(SubagentTemplateError::Unavailable)
    );
}

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openclaw-subagent-templates-{}-{nanos}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn directory(&self) -> SubagentTemplateDirectory {
        SubagentTemplateDirectory::try_new(self.path.clone()).unwrap()
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.path.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
