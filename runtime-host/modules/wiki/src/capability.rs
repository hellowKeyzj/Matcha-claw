use serde_json::{Value, json};

pub fn listed() -> Vec<Value> {
    vec![descriptor(json!({ "kind": "app" }))]
}

pub fn describe(id: &str, scope: &Value) -> Option<Value> {
    (id == "wiki" && scope.get("kind").and_then(Value::as_str) == Some("app"))
        .then(|| descriptor(scope.clone()))
}

fn descriptor(scope: Value) -> Value {
    json!({
        "id": "wiki",
        "kind": "wiki",
        "scopeKind": "app",
        "scope": scope,
        "targetKinds": ["wiki"],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("wiki.status", "Read wiki status", "wiki"),
            operation("wiki.projects", "List wiki projects", "wiki"),
            operation("wiki.projectTemplates", "List wiki project templates", "wiki"),
            operation("wiki.project.create", "Create wiki project", "wiki"),
            operation("wiki.project.open", "Open wiki project", "wiki"),
            operation("wiki.files", "List wiki files", "wiki"),
            operation("wiki.readFile", "Read wiki file", "wiki"),
            operation("wiki.readBinaryFile", "Read wiki binary file", "wiki"),
            operation("wiki.readSourcePreview", "Read wiki source preview", "wiki"),
            operation("wiki.writeFile", "Write wiki file", "wiki"),
            operation("wiki.search", "Search wiki", "wiki"),
            operation("wiki.graph", "Read wiki graph", "wiki"),
            operation("wiki.rescanSources", "Rescan wiki sources", "wiki"),
            operation("wiki.importSource", "Import wiki source", "wiki"),
            operation("wiki.importFolder", "Import wiki source folder", "wiki"),
            operation("wiki.refreshSources", "Refresh wiki sources", "wiki"),
            operation("wiki.applyGeneratedPages", "Apply generated wiki pages", "wiki"),
            operation("wiki.deleteSource", "Delete wiki source", "wiki"),
            operation("wiki.sourceFiles", "List wiki source files", "wiki"),
            operation("wiki.sourceTasks", "List wiki source tasks", "wiki"),
            operation("wiki.cancelSourceTask", "Cancel wiki source task", "wiki"),
            operation("wiki.reviews", "List wiki review items", "wiki"),
            operation("wiki.resolveReview", "Resolve wiki review item", "wiki"),
            operation("wiki.dismissReview", "Dismiss wiki review item", "wiki"),
            operation("wiki.clearResolvedReviews", "Clear resolved wiki reviews", "wiki"),
            operation("wiki.embedPage", "Embed wiki page", "wiki"),
            operation("wiki.retrieveContext", "Retrieve wiki context", "wiki")
        ],
        "policyScope": "wiki",
        "ownerModuleId": "wiki",
        "routeOwnerId": "runtime-host",
    })
}

fn operation(id: &'static str, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": id,
        "title": title,
        "targetKind": target_kind,
        "targetRequired": true,
    })
}
