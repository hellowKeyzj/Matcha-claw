use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDuplicateGroup {
    pub slugs: Vec<String>,
    pub reason: String,
    pub confidence: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupDetectInput {
    pub project_id: Option<String>,
    pub task_id: String,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupDetection {
    pub project_id: String,
    pub groups: Vec<WikiDuplicateGroup>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupMergeInput {
    pub project_id: Option<String>,
    pub group: WikiDuplicateGroup,
    pub canonical_slug: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupTaskInput {
    pub project_id: Option<String>,
    pub task_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupExcludeInput {
    pub project_id: Option<String>,
    pub slugs: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupTask {
    pub id: String,
    pub project_id: String,
    pub group: WikiDuplicateGroup,
    pub canonical_slug: String,
    pub status: WikiDedupTaskStatus,
    pub added_at: u64,
    pub error: Option<String>,
    pub retry_count: u32,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiDedupTaskStatus {
    Pending,
    Processing,
    Done,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDedupState {
    pub project_id: String,
    pub tasks: Vec<WikiDedupTask>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageLink {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageLinks {
    pub project_id: String,
    pub outgoing: Vec<WikiPageLink>,
    pub backlinks: Vec<WikiPageLink>,
    pub missing: Vec<WikiPageLink>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiMissingPageInput {
    pub project_id: Option<String>,
    pub task_id: String,
    pub title: String,
    pub linking_path: String,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiMissingPageCancelInput {
    pub project_id: Option<String>,
    pub task_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiMissingPageReceipt {
    pub project_id: String,
    pub path: String,
}
