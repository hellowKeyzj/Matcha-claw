#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogEntry {
    pub runtime: &'static str,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub platform: String,
    pub description: Option<String>,
    pub companion_skill_slugs: Option<Vec<String>>,
    pub enabled: bool,
    pub installed: bool,
    pub update_available: bool,
    pub companion_skill_ready: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Execution {
    pub enabled_plugin_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Catalog {
    pub success: bool,
    pub execution: Execution,
    pub plugins: Vec<CatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEntry {
    pub id: String,
    pub status: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Runtime {
    pub success: bool,
    pub lifecycle: &'static str,
    pub state: &'static str,
    pub health: &'static str,
    pub execution: Execution,
    pub plugins: Vec<RuntimeEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigurationOutcome {
    Configured,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    Install,
    Update,
    Uninstall,
}

impl Operation {
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "install" => Some(Self::Install),
            "update" => Some(Self::Update),
            "uninstall" => Some(Self::Uninstall),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationOutcome {
    Configured,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginError {
    Config,
}
