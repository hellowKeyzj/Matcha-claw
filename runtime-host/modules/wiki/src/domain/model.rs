use serde::{Deserialize, Serialize};

use super::revision::WikiRevision;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectRecord {
    project_id: String,
    title: String,
    root_path: String,
    created_at_ms: u64,
    opened_at_ms: u64,
}

impl WikiProjectRecord {
    pub fn new(
        project_id: String,
        title: String,
        root_path: String,
        created_at_ms: u64,
        opened_at_ms: u64,
    ) -> Self {
        Self {
            project_id,
            title,
            root_path,
            created_at_ms,
            opened_at_ms,
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn root_path(&self) -> &str {
        &self.root_path
    }

    pub const fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }

    pub const fn opened_at_ms(&self) -> u64 {
        self.opened_at_ms
    }

    pub fn touch_opened(&mut self, opened_at_ms: u64) {
        self.opened_at_ms = opened_at_ms;
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectRegistry {
    projects: Vec<WikiProjectRecord>,
}

impl WikiProjectRegistry {
    pub fn projects(&self) -> &[WikiProjectRecord] {
        &self.projects
    }

    pub fn into_projects(self) -> Vec<WikiProjectRecord> {
        self.projects
    }

    pub fn find(&self, project_id: &str) -> Option<&WikiProjectRecord> {
        self.projects
            .iter()
            .find(|project| project.project_id() == project_id)
    }

    pub fn upsert(&mut self, record: WikiProjectRecord) {
        if let Some(existing) = self
            .projects
            .iter_mut()
            .find(|project| project.project_id() == record.project_id())
        {
            *existing = record;
        } else {
            self.projects.push(record);
        }
        self.projects
            .sort_by(|left, right| left.title().cmp(right.title()));
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectView {
    project_id: String,
    title: String,
    root_path: String,
    is_current: bool,
    created_at_ms: u64,
    opened_at_ms: u64,
}

impl WikiProjectView {
    pub fn from_record(record: &WikiProjectRecord, current_project_id: Option<&str>) -> Self {
        Self {
            project_id: record.project_id().to_owned(),
            title: record.title().to_owned(),
            root_path: record.root_path().to_owned(),
            is_current: current_project_id == Some(record.project_id()),
            created_at_ms: record.created_at_ms(),
            opened_at_ms: record.opened_at_ms(),
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn root_path(&self) -> &str {
        &self.root_path
    }

    pub fn title(&self) -> &str {
        &self.title
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStatusReceipt {
    state_root: String,
    current_project: Option<WikiProjectView>,
    project_count: usize,
    pending_change_count: usize,
    layout: Option<WikiLayoutStatus>,
}

impl WikiStatusReceipt {
    pub fn new(
        state_root: String,
        current_project: Option<WikiProjectView>,
        project_count: usize,
        pending_change_count: usize,
        layout: Option<WikiLayoutStatus>,
    ) -> Self {
        Self {
            state_root,
            current_project,
            project_count,
            pending_change_count,
            layout,
        }
    }

    pub fn current_project(&self) -> Option<&WikiProjectView> {
        self.current_project.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectsReceipt {
    current_project_id: Option<String>,
    projects: Vec<WikiProjectView>,
}

impl WikiProjectsReceipt {
    pub fn new(current_project_id: Option<String>, projects: Vec<WikiProjectView>) -> Self {
        Self {
            current_project_id,
            projects,
        }
    }

    pub fn current_project_id(&self) -> Option<&str> {
        self.current_project_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectTemplateView {
    id: String,
    name: String,
    description: String,
    icon: String,
}

impl WikiProjectTemplateView {
    pub fn new(id: String, name: String, description: String, icon: String) -> Self {
        Self {
            id,
            name,
            description,
            icon,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectTemplatesReceipt {
    templates: Vec<WikiProjectTemplateView>,
}

impl WikiProjectTemplatesReceipt {
    pub fn new(templates: Vec<WikiProjectTemplateView>) -> Self {
        Self { templates }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLayoutStatus {
    raw_sources: bool,
    raw_assets: bool,
    wiki_entities: bool,
    wiki_concepts: bool,
    wiki_sources: bool,
    wiki_queries: bool,
    wiki_comparisons: bool,
    wiki_synthesis: bool,
    wiki_media: bool,
    llm_wiki: bool,
    lancedb: bool,
    file_snapshot: bool,
    file_change_queue: bool,
    embedding_revisions: bool,
}

impl WikiLayoutStatus {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        raw_sources: bool,
        raw_assets: bool,
        wiki_entities: bool,
        wiki_concepts: bool,
        wiki_sources: bool,
        wiki_queries: bool,
        wiki_comparisons: bool,
        wiki_synthesis: bool,
        wiki_media: bool,
        llm_wiki: bool,
        lancedb: bool,
        file_snapshot: bool,
        file_change_queue: bool,
        embedding_revisions: bool,
    ) -> Self {
        Self {
            raw_sources,
            raw_assets,
            wiki_entities,
            wiki_concepts,
            wiki_sources,
            wiki_queries,
            wiki_comparisons,
            wiki_synthesis,
            wiki_media,
            llm_wiki,
            lancedb,
            file_snapshot,
            file_change_queue,
            embedding_revisions,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiCreateProjectInput {
    pub root_path: String,
    pub title: Option<String>,
    pub template_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiOpenProjectInput {
    pub root_path: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectSelector {
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceWatchConfig {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_true")]
    auto_ingest: bool,
    #[serde(default = "default_output_language")]
    output_language: String,
    #[serde(default, deserialize_with = "deserialize_model_ref")]
    generation_model_ref: Option<String>,
    #[serde(default)]
    caption_enabled: bool,
    #[serde(default, deserialize_with = "deserialize_model_ref")]
    caption_model_ref: Option<String>,
    #[serde(default = "default_caption_concurrency")]
    caption_concurrency: u8,
    #[serde(default)]
    mineru_enabled: bool,
    #[serde(default = "default_mineru_backend")]
    mineru_backend: String,
    #[serde(default)]
    mineru_token_configured: bool,
    #[serde(default = "default_mineru_model_version")]
    mineru_model_version: String,
    #[serde(default = "default_mineru_local_endpoint")]
    mineru_local_endpoint: String,
    #[serde(default)]
    mineru_local_token_configured: bool,
    #[serde(default = "default_mineru_local_backend")]
    mineru_local_backend: String,
    #[serde(default = "default_mineru_local_effort")]
    mineru_local_effort: String,
    #[serde(default = "default_mineru_local_parse_method")]
    mineru_local_parse_method: String,
    #[serde(default = "default_mineru_local_language")]
    mineru_local_language: String,
    #[serde(default = "default_true")]
    mineru_local_formula_enabled: bool,
    #[serde(default = "default_true")]
    mineru_local_table_enabled: bool,
    #[serde(default = "default_true")]
    mineru_local_image_analysis: bool,
    #[serde(default)]
    mineru_local_server_url: String,
}

impl Default for WikiSourceWatchConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_ingest: true,
            output_language: default_output_language(),
            generation_model_ref: None,
            caption_enabled: false,
            caption_model_ref: None,
            caption_concurrency: default_caption_concurrency(),
            mineru_enabled: false,
            mineru_backend: default_mineru_backend(),
            mineru_token_configured: false,
            mineru_model_version: default_mineru_model_version(),
            mineru_local_endpoint: default_mineru_local_endpoint(),
            mineru_local_token_configured: false,
            mineru_local_backend: default_mineru_local_backend(),
            mineru_local_effort: default_mineru_local_effort(),
            mineru_local_parse_method: default_mineru_local_parse_method(),
            mineru_local_language: default_mineru_local_language(),
            mineru_local_formula_enabled: true,
            mineru_local_table_enabled: true,
            mineru_local_image_analysis: true,
            mineru_local_server_url: String::new(),
        }
    }
}

const fn default_true() -> bool {
    true
}

fn default_output_language() -> String {
    "auto".to_owned()
}

const fn default_caption_concurrency() -> u8 {
    4
}

fn default_mineru_backend() -> String {
    "cloud".to_owned()
}

fn default_mineru_model_version() -> String {
    "vlm".to_owned()
}

fn default_mineru_local_endpoint() -> String {
    "http://127.0.0.1:8000".to_owned()
}

fn default_mineru_local_backend() -> String {
    "hybrid-engine".to_owned()
}

fn default_mineru_local_effort() -> String {
    "medium".to_owned()
}

fn default_mineru_local_parse_method() -> String {
    "auto".to_owned()
}

fn default_mineru_local_language() -> String {
    "ch".to_owned()
}

impl WikiSourceWatchConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        enabled: bool,
        auto_ingest: bool,
        output_language: String,
        generation_model_ref: Option<String>,
        caption_enabled: bool,
        caption_model_ref: Option<String>,
        caption_concurrency: u8,
        mineru_enabled: bool,
        mineru_backend: String,
        mineru_model_version: String,
        mineru_local_endpoint: String,
        mineru_local_backend: String,
        mineru_local_effort: String,
        mineru_local_parse_method: String,
        mineru_local_language: String,
        mineru_local_formula_enabled: bool,
        mineru_local_table_enabled: bool,
        mineru_local_image_analysis: bool,
        mineru_local_server_url: String,
    ) -> Self {
        Self {
            enabled,
            auto_ingest,
            output_language,
            generation_model_ref: normalize_model_ref(generation_model_ref),
            caption_enabled,
            caption_model_ref: normalize_model_ref(caption_model_ref),
            caption_concurrency: caption_concurrency.clamp(1, 16),
            mineru_enabled,
            mineru_backend: normalize_mineru_choice(
                mineru_backend,
                &["cloud", "local"],
                default_mineru_backend(),
            ),
            mineru_token_configured: false,
            mineru_model_version: normalize_mineru_choice(
                mineru_model_version,
                &["vlm", "pipeline"],
                default_mineru_model_version(),
            ),
            mineru_local_endpoint: mineru_local_endpoint.trim().to_owned(),
            mineru_local_token_configured: false,
            mineru_local_backend: normalize_mineru_choice(
                mineru_local_backend,
                &[
                    "pipeline",
                    "vlm-engine",
                    "hybrid-engine",
                    "vlm-http-client",
                    "hybrid-http-client",
                ],
                default_mineru_local_backend(),
            ),
            mineru_local_effort: normalize_mineru_choice(
                mineru_local_effort,
                &["medium", "high"],
                default_mineru_local_effort(),
            ),
            mineru_local_parse_method: normalize_mineru_choice(
                mineru_local_parse_method,
                &["auto", "txt", "ocr"],
                default_mineru_local_parse_method(),
            ),
            mineru_local_language: mineru_local_language.trim().to_owned(),
            mineru_local_formula_enabled,
            mineru_local_table_enabled,
            mineru_local_image_analysis,
            mineru_local_server_url: mineru_local_server_url.trim().to_owned(),
        }
    }

    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    pub const fn auto_ingest(&self) -> bool {
        self.auto_ingest
    }

    pub fn output_language(&self) -> &str {
        &self.output_language
    }

    pub fn generation_model_ref(&self) -> Option<&str> {
        self.generation_model_ref.as_deref()
    }

    pub const fn caption_enabled(&self) -> bool {
        self.caption_enabled
    }

    pub fn caption_model_ref(&self) -> Option<&str> {
        self.caption_model_ref.as_deref()
    }

    pub const fn caption_concurrency(&self) -> u8 {
        self.caption_concurrency
    }

    pub const fn mineru_enabled(&self) -> bool {
        self.mineru_enabled
    }

    pub fn mineru_backend(&self) -> &str {
        &self.mineru_backend
    }

    pub const fn mineru_token_configured(&self) -> bool {
        self.mineru_token_configured
    }

    pub fn mineru_model_version(&self) -> &str {
        &self.mineru_model_version
    }

    pub fn mineru_local_endpoint(&self) -> &str {
        &self.mineru_local_endpoint
    }

    pub const fn mineru_local_token_configured(&self) -> bool {
        self.mineru_local_token_configured
    }

    pub fn mineru_local_backend(&self) -> &str {
        &self.mineru_local_backend
    }

    pub fn mineru_local_effort(&self) -> &str {
        &self.mineru_local_effort
    }

    pub fn mineru_local_parse_method(&self) -> &str {
        &self.mineru_local_parse_method
    }

    pub fn mineru_local_language(&self) -> &str {
        &self.mineru_local_language
    }

    pub const fn mineru_local_formula_enabled(&self) -> bool {
        self.mineru_local_formula_enabled
    }

    pub const fn mineru_local_table_enabled(&self) -> bool {
        self.mineru_local_table_enabled
    }

    pub const fn mineru_local_image_analysis(&self) -> bool {
        self.mineru_local_image_analysis
    }

    pub fn mineru_local_server_url(&self) -> &str {
        &self.mineru_local_server_url
    }

    pub fn with_mineru_private_flags(mut self, token: bool, local_token: bool) -> Self {
        self.mineru_token_configured = token;
        self.mineru_local_token_configured = local_token;
        self
    }
}

fn normalize_mineru_choice(value: String, allowed: &[&str], default: String) -> String {
    let value = value.trim();
    if allowed.contains(&value) {
        value.to_owned()
    } else {
        default
    }
}

fn normalize_model_ref(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn deserialize_model_ref<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(normalize_model_ref)
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceWatchConfigInput {
    pub project_id: Option<String>,
    pub enabled: Option<bool>,
    pub auto_ingest: Option<bool>,
    pub output_language: Option<String>,
    #[serde(default)]
    pub generation_model_ref: Option<String>,
    pub caption_enabled: Option<bool>,
    #[serde(default)]
    pub caption_model_ref: Option<String>,
    pub caption_concurrency: Option<u8>,
    pub mineru_enabled: Option<bool>,
    pub mineru_backend: Option<String>,
    pub mineru_token: Option<String>,
    pub mineru_model_version: Option<String>,
    pub mineru_local_endpoint: Option<String>,
    pub mineru_local_token: Option<String>,
    pub mineru_local_backend: Option<String>,
    pub mineru_local_effort: Option<String>,
    pub mineru_local_parse_method: Option<String>,
    pub mineru_local_language: Option<String>,
    pub mineru_local_formula_enabled: Option<bool>,
    pub mineru_local_table_enabled: Option<bool>,
    pub mineru_local_image_analysis: Option<bool>,
    pub mineru_local_server_url: Option<String>,
}

impl std::fmt::Debug for WikiSourceWatchConfigInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WikiSourceWatchConfigInput")
            .field("project_id", &self.project_id)
            .field("enabled", &self.enabled)
            .field("auto_ingest", &self.auto_ingest)
            .field("output_language", &self.output_language)
            .field("generation_model_ref", &self.generation_model_ref)
            .field("caption_enabled", &self.caption_enabled)
            .field("caption_model_ref", &self.caption_model_ref)
            .field("caption_concurrency", &self.caption_concurrency)
            .field("mineru_enabled", &self.mineru_enabled)
            .field("mineru_backend", &self.mineru_backend)
            .field(
                "mineru_token",
                &self.mineru_token.as_ref().map(|_| "<redacted>"),
            )
            .field("mineru_model_version", &self.mineru_model_version)
            .field("mineru_local_endpoint", &self.mineru_local_endpoint)
            .field(
                "mineru_local_token",
                &self.mineru_local_token.as_ref().map(|_| "<redacted>"),
            )
            .field("mineru_local_backend", &self.mineru_local_backend)
            .field("mineru_local_effort", &self.mineru_local_effort)
            .field("mineru_local_parse_method", &self.mineru_local_parse_method)
            .field("mineru_local_language", &self.mineru_local_language)
            .field(
                "mineru_local_formula_enabled",
                &self.mineru_local_formula_enabled,
            )
            .field(
                "mineru_local_table_enabled",
                &self.mineru_local_table_enabled,
            )
            .field(
                "mineru_local_image_analysis",
                &self.mineru_local_image_analysis,
            )
            .field("mineru_local_server_url", &self.mineru_local_server_url)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceWatchConfigReceipt {
    project_id: String,
    config: WikiSourceWatchConfig,
}

impl WikiSourceWatchConfigReceipt {
    pub fn new(project_id: String, config: WikiSourceWatchConfig) -> Self {
        Self { project_id, config }
    }

    pub fn config(&self) -> &WikiSourceWatchConfig {
        &self.config
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPathSelector {
    pub project_id: Option<String>,
    pub relative_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFilesInput {
    pub project_id: Option<String>,
    pub directory: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReadInput {
    pub project_id: Option<String>,
    pub relative_path: String,
    pub limit: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReadBinaryInput {
    pub project_id: Option<String>,
    pub relative_path: String,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiWriteInput {
    pub project_id: Option<String>,
    pub relative_path: String,
    pub content: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiArchiveExportInput {
    pub project_id: Option<String>,
    pub destination: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiArchiveImportInput {
    pub archive_path: String,
    pub destination: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiRebuildIndexReceipt {
    pub project_id: String,
    pub pages: usize,
    pub groups: usize,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiQuestionInput {
    pub project_id: Option<String>,
    pub task_id: String,
    pub model_ref: String,
    pub question: String,
    #[serde(default)]
    pub history: Vec<WikiQuestionHistory>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiQuestionHistory {
    pub role: WikiQuestionHistoryRole,
    pub content: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiQuestionHistoryRole {
    User,
    Assistant,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiQuestionReference {
    pub title: String,
    pub path: String,
    pub snippet: String,
    pub graph_related_to: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikiQuestionStatus {
    Queued,
    Retrieving,
    Answering,
    Done,
    Cancelled,
    Error,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiQuestionTask {
    pub id: String,
    pub project_id: String,
    pub question: String,
    pub model_ref: String,
    pub status: WikiQuestionStatus,
    pub answer: String,
    pub references: Vec<WikiQuestionReference>,
    pub error: Option<String>,
    pub saved_path: Option<String>,
    pub revision: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiQuestionTaskSelector {
    pub project_id: Option<String>,
    pub task_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiQuestionTaskReceipt {
    pub project_id: String,
    pub task: WikiQuestionTask,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiQuestionSaveReceipt {
    pub project_id: String,
    pub saved_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiImportSourceInput {
    pub project_id: Option<String>,
    pub source_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiImportSourceReceipt {
    source_relative_path: String,
    page_relative_path: String,
    revision: WikiRevision,
}

impl WikiImportSourceReceipt {
    pub fn new(
        source_relative_path: String,
        page_relative_path: String,
        revision: WikiRevision,
    ) -> Self {
        Self {
            source_relative_path,
            page_relative_path,
            revision,
        }
    }

    pub fn source_relative_path(&self) -> &str {
        &self.source_relative_path
    }

    pub fn page_relative_path(&self) -> &str {
        &self.page_relative_path
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiImportFolderInput {
    pub project_id: Option<String>,
    pub folder_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiImportFolderReceipt {
    imported: Vec<WikiImportSourceReceipt>,
    skipped: Vec<WikiSourceSkip>,
}

impl WikiImportFolderReceipt {
    pub fn new(imported: Vec<WikiImportSourceReceipt>, skipped: Vec<WikiSourceSkip>) -> Self {
        Self { imported, skipped }
    }

    pub(crate) fn imported(&self) -> &[WikiImportSourceReceipt] {
        &self.imported
    }

    pub(crate) fn skipped(&self) -> &[WikiSourceSkip] {
        &self.skipped
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceSkip {
    path: String,
    reason: String,
}

impl WikiSourceSkip {
    pub fn new(path: String, reason: String) -> Self {
        Self { path, reason }
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiRefreshSourcesReceipt {
    imported: Vec<WikiImportSourceReceipt>,
    deleted: Vec<WikiDeleteSourceReceipt>,
    moved: Vec<WikiSourceMoveReceipt>,
    skipped: Vec<WikiSourceSkip>,
}

impl WikiRefreshSourcesReceipt {
    pub fn new(
        imported: Vec<WikiImportSourceReceipt>,
        deleted: Vec<WikiDeleteSourceReceipt>,
        moved: Vec<WikiSourceMoveReceipt>,
        skipped: Vec<WikiSourceSkip>,
    ) -> Self {
        Self {
            imported,
            deleted,
            moved,
            skipped,
        }
    }

    pub(crate) fn imported(&self) -> &[WikiImportSourceReceipt] {
        &self.imported
    }

    pub(crate) fn skipped(&self) -> &[WikiSourceSkip] {
        &self.skipped
    }

    pub(crate) fn deleted(&self) -> &[WikiDeleteSourceReceipt] {
        &self.deleted
    }

    pub(crate) fn moved(&self) -> &[WikiSourceMoveReceipt] {
        &self.moved
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDeleteSourceInput {
    pub project_id: Option<String>,
    pub source_path: String,
    pub file_already_deleted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDeleteSourceReceipt {
    source_relative_path: String,
    deleted_pages: Vec<String>,
    updated_pages: Vec<String>,
    deleted_media: Vec<String>,
}

impl WikiDeleteSourceReceipt {
    pub fn new(
        source_relative_path: String,
        deleted_pages: Vec<String>,
        updated_pages: Vec<String>,
        deleted_media: Vec<String>,
    ) -> Self {
        Self {
            source_relative_path,
            deleted_pages,
            updated_pages,
            deleted_media,
        }
    }

    pub(crate) fn deleted_pages(&self) -> &[String] {
        &self.deleted_pages
    }
    pub(crate) fn updated_pages(&self) -> &[String] {
        &self.updated_pages
    }
    pub(crate) fn deleted_media(&self) -> &[String] {
        &self.deleted_media
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceMoveReceipt {
    old_source_relative_path: String,
    new_source_relative_path: String,
    updated_pages: Vec<String>,
    moved_summary: Option<String>,
}

impl WikiSourceMoveReceipt {
    pub fn new(
        old_source_relative_path: String,
        new_source_relative_path: String,
        updated_pages: Vec<String>,
        moved_summary: Option<String>,
    ) -> Self {
        Self {
            old_source_relative_path,
            new_source_relative_path,
            updated_pages,
            moved_summary,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiReviewType {
    Contradiction,
    Duplicate,
    MissingPage,
    Confirm,
    Suggestion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewOption {
    pub label: String,
    pub action: String,
}

impl WikiReviewOption {
    pub fn new(label: String, action: String) -> Self {
        Self { label, action }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewItem {
    pub id: String,
    #[serde(rename = "type")]
    pub review_type: WikiReviewType,
    pub title: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default)]
    pub affected_pages: Vec<String>,
    #[serde(default)]
    pub search_queries: Vec<String>,
    #[serde(default)]
    pub options: Vec<WikiReviewOption>,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_action: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewsReceipt {
    items: Vec<WikiReviewItem>,
}

impl WikiReviewsReceipt {
    pub fn new(items: Vec<WikiReviewItem>) -> Self {
        Self { items }
    }

    pub fn items(&self) -> &[WikiReviewItem] {
        &self.items
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewResolveInput {
    pub project_id: Option<String>,
    pub id: String,
    pub action: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewDismissInput {
    pub project_id: Option<String>,
    pub id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReviewClearResolvedInput {
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGeneratedPageInput {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiApplyGeneratedPagesInput {
    pub project_id: Option<String>,
    pub source_path: String,
    pub files: Vec<WikiGeneratedPageInput>,
    #[serde(default)]
    pub reviews: Vec<WikiReviewItem>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiApplyGeneratedPagesReceipt {
    written_pages: Vec<WikiWriteReceipt>,
}

impl WikiApplyGeneratedPagesReceipt {
    pub fn new(written_pages: Vec<WikiWriteReceipt>) -> Self {
        Self { written_pages }
    }

    pub fn written_pages(&self) -> &[WikiWriteReceipt] {
        &self.written_pages
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceTasksReceipt {
    tasks: Vec<WikiSourceTask>,
}

impl WikiSourceTasksReceipt {
    pub fn new(tasks: Vec<WikiSourceTask>) -> Self {
        Self { tasks }
    }

    pub(crate) fn tasks(&self) -> &[WikiSourceTask] {
        &self.tasks
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceTask {
    id: String,
    project_id: String,
    source_path: String,
    kind: WikiSourceTaskKind,
    status: WikiSourceTaskStatus,
    added_at_ms: u64,
    updated_at_ms: u64,
    retry_count: u32,
    error: Option<String>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    progress: Option<u8>,
    #[serde(default)]
    cancel_requested_at_ms: Option<u64>,
}

impl WikiSourceTask {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: String,
        project_id: String,
        source_path: String,
        kind: WikiSourceTaskKind,
        status: WikiSourceTaskStatus,
        added_at_ms: u64,
        updated_at_ms: u64,
        retry_count: u32,
        error: Option<String>,
    ) -> Self {
        Self {
            id,
            project_id,
            source_path,
            kind,
            status,
            added_at_ms,
            updated_at_ms,
            retry_count,
            error,
            stage: None,
            progress: None,
            cancel_requested_at_ms: None,
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn source_path(&self) -> &str {
        &self.source_path
    }

    pub const fn kind(&self) -> &WikiSourceTaskKind {
        &self.kind
    }

    pub fn status(&self) -> &WikiSourceTaskStatus {
        &self.status
    }

    pub fn is_paused(&self) -> bool {
        self.stage.as_deref() == Some("paused")
    }

    pub const fn cancel_requested(&self) -> bool {
        self.cancel_requested_at_ms.is_some()
    }

    pub fn mark_running(&mut self, stage: impl Into<String>, progress: u8) {
        self.status = WikiSourceTaskStatus::Running;
        self.stage = Some(stage.into());
        self.progress = Some(progress.min(100));
        self.updated_at_ms = crate::domain::now_ms();
    }

    pub fn mark_pending(&mut self, stage: Option<String>) {
        self.status = WikiSourceTaskStatus::Pending;
        self.stage = stage;
        self.progress = None;
        self.updated_at_ms = crate::domain::now_ms();
        self.error = None;
        self.cancel_requested_at_ms = None;
    }

    pub fn restart(&mut self) {
        self.mark_pending(None);
        self.retry_count = 0;
    }

    pub fn pause(&mut self) {
        self.status = WikiSourceTaskStatus::Pending;
        self.stage = Some("paused".to_owned());
        self.progress = None;
        self.updated_at_ms = crate::domain::now_ms();
        self.error = None;
        self.cancel_requested_at_ms = Some(self.updated_at_ms);
    }

    pub fn request_cancel(&mut self) {
        self.cancel_requested_at_ms = Some(crate::domain::now_ms());
        self.updated_at_ms = crate::domain::now_ms();
    }

    pub fn mark_cancelled(&mut self) {
        self.status = WikiSourceTaskStatus::Cancelled;
        self.stage = Some("cancelled".to_owned());
        self.progress = Some(100);
        self.updated_at_ms = crate::domain::now_ms();
        self.error = None;
    }

    pub fn mark_done(&mut self) {
        self.status = WikiSourceTaskStatus::Done;
        self.stage = Some("done".to_owned());
        self.progress = Some(100);
        self.updated_at_ms = crate::domain::now_ms();
        self.error = None;
    }

    pub fn mark_failed(&mut self, error: String) {
        self.status = WikiSourceTaskStatus::Failed;
        self.updated_at_ms = crate::domain::now_ms();
        self.retry_count = self.retry_count.saturating_add(1);
        self.error = Some(error);
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiCancelSourceTaskInput {
    pub project_id: Option<String>,
    pub source_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceTaskActionInput {
    pub project_id: Option<String>,
    pub source_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReorderSourceTaskInput {
    pub project_id: Option<String>,
    pub source_path: String,
    pub before_source_path: Option<String>,
    pub after_source_path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WikiSourceTaskKind {
    Created,
    Modified,
    Deleted,
    Moved,
    Imported,
    Generated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WikiSourceTaskStatus {
    Pending,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchInput {
    pub project_id: Option<String>,
    pub query: String,
    pub limit: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiRetrieveContextInput {
    pub project_id: Option<String>,
    pub query: String,
    pub limit: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFileEntry {
    relative_path: String,
    is_directory: bool,
    size: u64,
    modified_at_ms: u64,
}

impl WikiFileEntry {
    pub fn new(relative_path: String, is_directory: bool, size: u64, modified_at_ms: u64) -> Self {
        Self {
            relative_path,
            is_directory,
            size,
            modified_at_ms,
        }
    }

    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiFilesReceipt {
    root: String,
    entries: Vec<WikiFileEntry>,
}

impl WikiFilesReceipt {
    pub fn new(root: String, entries: Vec<WikiFileEntry>) -> Self {
        Self { root, entries }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSourceFilesReceipt {
    entries: Vec<WikiFileEntry>,
}

impl WikiSourceFilesReceipt {
    pub fn new(entries: Vec<WikiFileEntry>) -> Self {
        Self { entries }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReadReceipt {
    relative_path: String,
    content: String,
    revision: WikiRevision,
}

impl WikiReadReceipt {
    pub fn new(relative_path: String, content: String, revision: WikiRevision) -> Self {
        Self {
            relative_path,
            content,
            revision,
        }
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn revision(&self) -> &WikiRevision {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReadBinaryReceipt {
    name: String,
    data: String,
    size: u64,
}

impl WikiReadBinaryReceipt {
    pub fn new(name: String, data: String, size: u64) -> Self {
        Self { name, data, size }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiWriteReceipt {
    relative_path: String,
    revision: WikiRevision,
}

impl WikiWriteReceipt {
    pub fn new(relative_path: String, revision: WikiRevision) -> Self {
        Self {
            relative_path,
            revision,
        }
    }

    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchImage {
    pub url: String,
    pub alt: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchHit {
    pub(crate) relative_path: String,
    pub(crate) title: String,
    pub(crate) score: f64,
    pub(crate) snippets: Vec<String>,
    pub(crate) title_match: bool,
    pub(crate) vector_score: Option<f64>,
    pub(crate) images: Vec<WikiSearchImage>,
    pub(crate) content: Option<String>,
    pub(crate) graph_related_to: Vec<String>,
}

impl WikiSearchHit {
    pub fn new(relative_path: String, title: String, score: f64, snippets: Vec<String>) -> Self {
        Self {
            relative_path,
            title,
            score,
            snippets,
            title_match: false,
            vector_score: None,
            images: Vec::new(),
            content: None,
            graph_related_to: Vec::new(),
        }
    }

    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub const fn score(&self) -> f64 {
        self.score
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchReceipt {
    pub(crate) query: String,
    pub(crate) hits: Vec<WikiSearchHit>,
    pub(crate) mode: String,
    pub(crate) token_hits: usize,
    pub(crate) vector_hits: usize,
    pub(crate) graph_hits: usize,
}

impl WikiSearchReceipt {
    pub fn new(query: String, hits: Vec<WikiSearchHit>) -> Self {
        let token_hits = hits.len();
        Self {
            query,
            hits,
            mode: "keyword".to_owned(),
            token_hits,
            vector_hits: 0,
            graph_hits: 0,
        }
    }

    pub fn hits(&self) -> &[WikiSearchHit] {
        &self.hits
    }
}
