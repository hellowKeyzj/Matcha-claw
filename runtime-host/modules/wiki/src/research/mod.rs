mod sources;
pub(crate) mod synthesis;
mod tasks;
pub(crate) mod workflow;

use serde::{Deserialize, Serialize};

pub use crate::external_search::ResearchSource;
pub(crate) use tasks::ResearchTasks;
pub(crate) use workflow::{ResearchPlan, ResearchScheduler};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiResearchInput {
    pub project_id: Option<String>,
    pub inputs: Vec<WikiResearchTaskInput>,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiResearchTaskInput {
    pub topic: String,
    pub search_queries: Option<Vec<String>>,
    pub source_review_id: Option<String>,
    pub rerun_of_task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiResearchTaskActionInput {
    pub project_id: Option<String>,
    pub task_id: String,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiResearchRemoveInput {
    pub project_id: Option<String>,
    pub task_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiResearchTaskStatus {
    Queued,
    Searching,
    Synthesizing,
    Saving,
    Done,
    Error,
}

impl WikiResearchTaskStatus {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Error)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiResearchTask {
    pub id: String,
    pub topic: String,
    pub search_queries: Vec<String>,
    pub source_review_id: Option<String>,
    pub rerun_of_task_id: Option<String>,
    pub status: WikiResearchTaskStatus,
    pub web_results: Vec<ResearchSource>,
    pub synthesis: String,
    pub saved_path: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub project_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiResearchTasksReceipt {
    pub project_id: String,
    pub tasks: Vec<WikiResearchTask>,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct ResearchCounts {
    pub done: usize,
    pub error: usize,
    pub saved: usize,
}
