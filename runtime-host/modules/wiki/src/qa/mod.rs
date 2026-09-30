pub(crate) mod prompts;
mod tasks;
pub(crate) mod workflow;

pub(crate) use tasks::QuestionTasks;

use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

use crate::{
    domain::model::{WikiQuestionHistory, WikiQuestionTask},
    ports::WikiIngestLlm,
};

pub(crate) struct QuestionPlan {
    pub project_root: PathBuf,
    pub project_id: String,
    pub task: WikiQuestionTask,
    pub history: Vec<WikiQuestionHistory>,
    pub overview: String,
    pub schema: String,
    pub tasks: Arc<QuestionTasks>,
    pub llm: Arc<dyn WikiIngestLlm>,
    pub cancellation: CancellationToken,
}
