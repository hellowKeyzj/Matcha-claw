use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogEntry {
    pub(crate) runtime: &'static str,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) kind: String,
    pub(crate) platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) companion_skill_slugs: Option<Vec<String>>,
    pub(crate) enabled: bool,
    pub(crate) installed: bool,
    pub(crate) update_available: bool,
    pub(crate) companion_skill_ready: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Execution {
    pub(crate) enabled_plugin_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub(crate) success: bool,
    pub(crate) execution: Execution,
    pub(crate) plugins: Vec<CatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEntry {
    pub(crate) id: String,
    pub(crate) status: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Runtime {
    pub(crate) success: bool,
    pub(crate) lifecycle: &'static str,
    pub(crate) state: &'static str,
    pub(crate) health: &'static str,
    pub(crate) execution: Execution,
    pub(crate) plugins: Vec<RuntimeEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConfigurationOutcome {
    Configured,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    Install,
    Update,
    Uninstall,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OperationOutcome {
    Configured,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PluginError {
    Config,
}
