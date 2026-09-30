use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFileHistoryEntry {
    pub id: String,
    pub path: String,
    pub timestamp: i64,
    pub author: String,
    pub tool: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiFileHistoryInput {
    pub project_id: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiRestoreFileHistoryInput {
    pub project_id: Option<String>,
    pub path: String,
    pub version_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFileHistoryReceipt {
    pub project_id: String,
    pub path: String,
    pub entries: Vec<WikiFileHistoryEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WikiFileHistorySettings {
    pub enabled: bool,
    pub max_versions_per_file: usize,
}

impl Default for WikiFileHistorySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            max_versions_per_file: 10,
        }
    }
}

impl WikiFileHistorySettings {
    pub(super) fn normalized(mut self) -> Self {
        self.max_versions_per_file = self.max_versions_per_file.min(30);
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFileHistorySettingsInput {
    pub project_id: Option<String>,
    #[serde(flatten)]
    pub settings: WikiFileHistorySettings,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFileHistoryStats {
    pub bytes: u64,
    pub files: usize,
    pub entries: usize,
}
