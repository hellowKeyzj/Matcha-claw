use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiSelectionIntent {
    Ask,
    Edit,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionSnapshot {
    pub prefix: String,
    pub selected_text: String,
    pub suffix: String,
    pub source_mapped: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionTurn {
    pub question: String,
    pub answer: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionInput {
    pub project_id: Option<String>,
    pub task_id: String,
    pub relative_path: String,
    pub intent: WikiSelectionIntent,
    pub instruction: String,
    pub selection: WikiSelectionSnapshot,
    pub history: Vec<WikiSelectionTurn>,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionTaskInput {
    pub project_id: Option<String>,
    pub task_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiSelectionStatus {
    Queued,
    Retrieving,
    Generating,
    Done,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionReference {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionTask {
    pub project_id: String,
    pub task_id: String,
    pub relative_path: String,
    pub intent: WikiSelectionIntent,
    pub status: WikiSelectionStatus,
    pub content: String,
    pub references: Vec<WikiSelectionReference>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionApplyInput {
    pub project_id: Option<String>,
    pub relative_path: String,
    pub selection: WikiSelectionSnapshot,
    pub replacement: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSelectionApplyReceipt {
    pub project_id: String,
    pub relative_path: String,
    pub content: String,
}
