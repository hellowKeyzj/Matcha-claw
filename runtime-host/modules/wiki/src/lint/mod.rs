use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{domain::WikiFailure, ports::WikiIngestLlm};

mod fixes;
mod pages;
mod semantic;
mod structural;

pub(crate) use fixes::{append_wikilink, rewrite_wikilink_target, stub};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiLintConfig {
    #[serde(default)]
    pub ignore_orphan: bool,
    #[serde(default)]
    pub ignore_no_outlinks: bool,
    #[serde(default)]
    pub ignore_pages: Vec<String>,
}

impl WikiLintConfig {
    pub(crate) fn normalize(mut self) -> Self {
        let mut pages = Vec::new();
        for page in self
            .ignore_pages
            .iter()
            .flat_map(|page| page.split([',', '，', '\n']))
        {
            let page = page.trim();
            if !page.is_empty() && !pages.iter().any(|existing| existing == page) {
                pages.push(page.to_owned());
            }
        }
        self.ignore_pages = pages;
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiLintType {
    Orphan,
    BrokenLink,
    NoOutlinks,
    Semantic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiLintSeverity {
    Warning,
    Info,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLintFinding {
    pub id: String,
    #[serde(rename = "type")]
    pub finding_type: WikiLintType,
    pub severity: WikiLintSeverity,
    pub page: String,
    pub detail: String,
    #[serde(default)]
    pub affected_pages: Vec<String>,
    #[serde(default)]
    pub broken_target: Option<String>,
    #[serde(default)]
    pub suggested_target: Option<String>,
    #[serde(default)]
    pub suggested_source: Option<String>,
    pub created_at: u64,
}

impl WikiLintFinding {
    pub(crate) fn new(
        finding_type: WikiLintType,
        severity: WikiLintSeverity,
        page: String,
        detail: String,
    ) -> Self {
        Self {
            id: String::new(),
            finding_type,
            severity,
            page,
            detail,
            affected_pages: Vec::new(),
            broken_target: None,
            suggested_target: None,
            suggested_source: None,
            created_at: crate::domain::now_ms(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiLintRunInput {
    pub project_id: Option<String>,
    #[serde(default)]
    pub semantic: bool,
    pub model_ref: Option<String>,
    pub output_language: Option<String>,
    pub config: Option<WikiLintConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiLintConfigInput {
    pub project_id: Option<String>,
    pub ignore_orphan: bool,
    pub ignore_no_outlinks: bool,
    pub ignore_pages: Vec<String>,
}

impl WikiLintConfigInput {
    pub(crate) fn into_config(self) -> WikiLintConfig {
        WikiLintConfig {
            ignore_orphan: self.ignore_orphan,
            ignore_no_outlinks: self.ignore_no_outlinks,
            ignore_pages: self.ignore_pages,
        }
        .normalize()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiLintActionInput {
    pub project_id: Option<String>,
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiLintCancelInput {
    pub project_id: Option<String>,
    pub task_id: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiLintPhase {
    #[default]
    Idle,
    Reading,
    Structural,
    Semantic,
    Done,
    Cancelled,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLintState {
    pub project_id: String,
    pub task_id: Option<String>,
    pub phase: WikiLintPhase,
    pub completed: usize,
    pub total: usize,
    pub items: Vec<WikiLintFinding>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLintFixReceipt {
    pub project_id: String,
    pub fixed_ids: Vec<String>,
    pub reviewed_ids: Vec<String>,
    pub written_pages: Vec<String>,
    pub deleted_pages: Vec<String>,
    pub failures: Vec<WikiLintFixFailure>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLintFixFailure {
    pub id: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum LintAction {
    Fix,
    Review,
    Delete,
}

#[derive(Clone)]
pub(crate) struct LintRunPlan {
    pub project_id: String,
    pub root: PathBuf,
    pub input: WikiLintRunInput,
    pub task_id: String,
    pub cancellation: CancellationToken,
    pub llm: Option<Arc<dyn WikiIngestLlm>>,
    pub runs: Arc<LintRuns>,
}

pub(crate) struct LintRunGuard {
    pub project_id: String,
    pub task_id: String,
    pub runs: Arc<LintRuns>,
}

impl Drop for LintRunGuard {
    fn drop(&mut self) {
        let mut runs = self.runs.runs.lock().unwrap();
        if let Some(run) = runs
            .get_mut(&self.project_id)
            .filter(|run| run.state.task_id.as_deref() == Some(&self.task_id))
        {
            if matches!(
                run.state.phase,
                WikiLintPhase::Reading | WikiLintPhase::Structural | WikiLintPhase::Semantic
            ) {
                run.cancellation.cancel();
                run.state.phase = WikiLintPhase::Error;
                run.state.error = Some("Wiki lint did not complete.".to_owned());
            }
        }
    }
}

pub(crate) struct LintRun {
    pub state: WikiLintState,
    pub cancellation: CancellationToken,
}

#[derive(Default)]
pub(crate) struct LintRuns {
    pub runs: Mutex<BTreeMap<String, LintRun>>,
}

impl LintRuns {
    pub(crate) fn progress(
        &self,
        plan: &LintRunPlan,
        phase: WikiLintPhase,
        completed: usize,
        total: usize,
    ) {
        let mut runs = self.runs.lock().unwrap();
        if let Some(run) = runs
            .get_mut(&plan.project_id)
            .filter(|run| run.state.task_id.as_deref() == Some(&plan.task_id))
        {
            run.state.phase = phase;
            run.state.completed = completed;
            run.state.total = total;
        }
    }
}

pub(crate) async fn run(
    plan: &LintRunPlan,
    llm: Option<&dyn WikiIngestLlm>,
    runs: &LintRuns,
) -> Result<Vec<WikiLintFinding>, WikiFailure> {
    let structural_plan = plan.clone();
    let (pages, mut findings) = tokio::task::spawn_blocking(move || {
        let pages = pages::load_for_run(&structural_plan, &structural_plan.runs)?;
        let findings = structural::run(&pages, &structural_plan, &structural_plan.runs)?;
        Ok::<_, WikiFailure>((pages, findings))
    })
    .await
    .map_err(|_| WikiFailure::OwnerUnavailable)??;
    if plan.input.semantic {
        runs.progress(plan, WikiLintPhase::Semantic, 0, 0);
        findings.extend(semantic::run(&pages, &plan.input, llm, &plan.cancellation).await?);
    }
    for (index, finding) in findings.iter_mut().enumerate() {
        finding.id = format!("lint-{}-{}", plan.task_id, index + 1);
    }
    Ok(findings)
}

pub(crate) fn public_failure(failure: &WikiFailure) -> String {
    match failure {
        WikiFailure::Cancelled => "Wiki lint cancelled.",
        WikiFailure::InvalidInput { .. }
        | WikiFailure::InvalidPath { .. }
        | WikiFailure::PathOutsideProject { .. } => "Invalid Wiki lint input.",
        WikiFailure::NotFound { .. } => "Wiki page no longer exists.",
        WikiFailure::OwnerUnavailable => "Wiki lint owner unavailable.",
        _ => "Wiki lint failed.",
    }
    .to_owned()
}
