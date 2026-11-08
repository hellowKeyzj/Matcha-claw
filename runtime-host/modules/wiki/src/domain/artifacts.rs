use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WikiArtifactInput {
    pub plugin_id: String,
    pub project_id: String,
    pub request_key: String,
    pub title: String,
    pub source_url: Option<String>,
    pub main_file: WikiArtifactFileInput,
    #[serde(default)]
    pub attachments: Vec<WikiArtifactFileInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WikiArtifactFileInput {
    pub relative_path: String,
    pub mime_type: String,
    pub content_base64: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WikiArtifactSelector {
    pub plugin_id: String,
    pub project_id: String,
    pub request_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiArtifactReceipt {
    pub archive_id: String,
    pub project_id: String,
    pub request_key: String,
    pub title: String,
    pub source_url: Option<String>,
    pub call_id: platform::call::CallId,
    pub accepted: bool,
    pub save_state: WikiArtifactSaveState,
    pub files: Vec<WikiArtifactFileReceipt>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WikiArtifactSaveState {
    Saved,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiArtifactFileReceipt {
    pub relative_path: String,
    pub mime_type: String,
    pub byte_length: usize,
    pub source_path: String,
    pub task_id: Option<String>,
    pub parse_state: WikiArtifactProcessingState,
    // Source-page/snapshot indexing only; the existing vector write remains best-effort.
    pub index_state: WikiArtifactProcessingState,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WikiArtifactProcessingState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Unsupported,
    Unknown,
}
