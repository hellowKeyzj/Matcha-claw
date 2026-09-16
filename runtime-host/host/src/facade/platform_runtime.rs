use std::{collections::BTreeMap, sync::Arc};

use serde::Deserialize;

use crate::{composition::HostAdmission, runtime::adapters::openclaw::OpenClawInstance};

#[derive(Clone)]
pub(crate) struct PlatformRuntimeHandle {
    admission: Arc<HostAdmission>,
    open_claw: Arc<OpenClawInstance>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstallationStatus {
    pub(crate) package_exists: bool,
    pub(crate) is_built: bool,
    pub(crate) dir: String,
    pub(crate) version: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimePaths {
    pub(crate) openclaw_directory: String,
    pub(crate) config_directory: String,
    pub(crate) workspace_directory: String,
    pub(crate) task_workspace_directories: Vec<String>,
    pub(crate) skills_directory: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CliCommand {
    pub(crate) command: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlatformRuntimeError {
    Unavailable,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolPermissionMode {
    Default,
    FullAccess,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ToolPermissionEffect {
    Unchanged,
    Written,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SubagentTemplateCatalog {
    pub(crate) categories: Vec<SubagentTemplateCategory>,
    pub(crate) templates: Vec<SubagentTemplateSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SubagentTemplateDetail {
    pub(crate) template: SubagentTemplate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SubagentTemplateCategory {
    pub(crate) id: String,
    pub(crate) order: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SubagentTemplateSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) summary: Option<String>,
    pub(crate) category_id: Option<String>,
    pub(crate) subcategory_id: Option<String>,
    pub(crate) order: Option<i64>,
    pub(crate) files: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SubagentTemplate {
    pub(crate) summary: SubagentTemplateSummary,
    pub(crate) file_contents: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SubagentTemplateError {
    Unavailable,
    NotFound,
}

impl PlatformRuntimeHandle {
    pub(crate) fn new(admission: Arc<HostAdmission>, open_claw: Arc<OpenClawInstance>) -> Self {
        Self {
            admission,
            open_claw,
        }
    }

    pub(crate) async fn installation_status(&self) -> Result<Option<InstallationStatus>, ()> {
        self.admission.admit_request().map_err(|_| ())?;
        Ok(self
            .open_claw
            .installation_status()
            .map(InstallationStatus::from))
    }

    pub(crate) async fn runtime_paths_available(
        &self,
    ) -> Result<RuntimePaths, PlatformRuntimeError> {
        self.admission
            .admit_request()
            .map_err(|_| PlatformRuntimeError::Unavailable)?;
        self.open_claw
            .runtime_paths()
            .map(RuntimePaths::from)
            .map_err(|_| PlatformRuntimeError::Unavailable)
    }

    pub(crate) async fn cli_command_available(&self) -> Result<CliCommand, PlatformRuntimeError> {
        self.admission
            .admit_request()
            .map_err(|_| PlatformRuntimeError::Unavailable)?;
        self.open_claw
            .cli_command()
            .map(CliCommand::from)
            .map_err(|_| PlatformRuntimeError::Unavailable)
    }

    pub(crate) async fn tool_permission_mode(
        &self,
    ) -> Result<ToolPermissionMode, PlatformRuntimeError> {
        self.admission
            .admit_request()
            .map_err(|_| PlatformRuntimeError::Unavailable)?;
        self.open_claw
            .tool_permission_mode()
            .map(ToolPermissionMode::from)
            .map_err(PlatformRuntimeError::from)
    }

    pub(crate) async fn set_tool_permission_mode(
        &self,
        mode: ToolPermissionMode,
    ) -> Result<ToolPermissionEffect, PlatformRuntimeError> {
        self.admission
            .admit_request()
            .map_err(|_| PlatformRuntimeError::Unavailable)?;
        self.open_claw
            .set_tool_permission_mode(mode.into())
            .map(ToolPermissionEffect::from)
            .map_err(PlatformRuntimeError::from)
    }

    pub(crate) async fn subagent_template_catalog(
        &self,
    ) -> Result<SubagentTemplateCatalog, SubagentTemplateError> {
        self.admission
            .admit_request()
            .map_err(|_| SubagentTemplateError::Unavailable)?;
        self.open_claw
            .subagent_template_catalog()
            .map(SubagentTemplateCatalog::from)
            .map_err(SubagentTemplateError::from)
    }

    pub(crate) async fn subagent_template(
        &self,
        id: &str,
    ) -> Result<SubagentTemplateDetail, SubagentTemplateError> {
        self.admission
            .admit_request()
            .map_err(|_| SubagentTemplateError::Unavailable)?;
        self.open_claw
            .subagent_template(id)
            .map(SubagentTemplateDetail::from)
            .map_err(SubagentTemplateError::from)
    }
}

impl ToolPermissionMode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::FullAccess => "fullAccess",
        }
    }
}

impl From<openclaw::projection::installation::Status> for InstallationStatus {
    fn from(status: openclaw::projection::installation::Status) -> Self {
        Self {
            package_exists: status.package_exists(),
            is_built: status.is_built(),
            dir: status.dir().to_owned(),
            version: status.version().map(str::to_owned),
        }
    }
}

impl From<openclaw::projection::runtime_paths::RuntimePaths> for RuntimePaths {
    fn from(paths: openclaw::projection::runtime_paths::RuntimePaths) -> Self {
        Self {
            openclaw_directory: paths.openclaw_directory().to_owned(),
            config_directory: paths.config_directory().to_owned(),
            workspace_directory: paths.workspace_directory().to_owned(),
            task_workspace_directories: paths.task_workspace_directories().to_vec(),
            skills_directory: paths.skills_directory().to_owned(),
        }
    }
}

impl From<openclaw::projection::runtime_paths::CliCommand> for CliCommand {
    fn from(command: openclaw::projection::runtime_paths::CliCommand) -> Self {
        Self {
            command: command.command().to_owned(),
        }
    }
}

impl From<openclaw::projection::tool_permission::Mode> for ToolPermissionMode {
    fn from(mode: openclaw::projection::tool_permission::Mode) -> Self {
        match mode {
            openclaw::projection::tool_permission::Mode::Default => Self::Default,
            openclaw::projection::tool_permission::Mode::FullAccess => Self::FullAccess,
        }
    }
}

impl From<ToolPermissionMode> for openclaw::projection::tool_permission::Mode {
    fn from(mode: ToolPermissionMode) -> Self {
        match mode {
            ToolPermissionMode::Default => Self::Default,
            ToolPermissionMode::FullAccess => Self::FullAccess,
        }
    }
}

impl From<openclaw::projection::tool_permission::Effect> for ToolPermissionEffect {
    fn from(effect: openclaw::projection::tool_permission::Effect) -> Self {
        match effect {
            openclaw::projection::tool_permission::Effect::Unchanged => Self::Unchanged,
            openclaw::projection::tool_permission::Effect::Written => Self::Written,
        }
    }
}

impl From<openclaw::projection::tool_permission::Error> for PlatformRuntimeError {
    fn from(error: openclaw::projection::tool_permission::Error) -> Self {
        match error {
            openclaw::projection::tool_permission::Error::Unavailable => Self::Unavailable,
            openclaw::projection::tool_permission::Error::Unknown => Self::Unknown,
        }
    }
}

impl From<openclaw::projection::subagent_templates::SubagentTemplateError>
    for SubagentTemplateError
{
    fn from(error: openclaw::projection::subagent_templates::SubagentTemplateError) -> Self {
        match error {
            openclaw::projection::subagent_templates::SubagentTemplateError::Unavailable => {
                Self::Unavailable
            }
            openclaw::projection::subagent_templates::SubagentTemplateError::NotFound => {
                Self::NotFound
            }
        }
    }
}

impl From<openclaw::projection::subagent_templates::Catalog> for SubagentTemplateCatalog {
    fn from(catalog: openclaw::projection::subagent_templates::Catalog) -> Self {
        Self {
            categories: catalog
                .categories()
                .iter()
                .map(SubagentTemplateCategory::from)
                .collect(),
            templates: catalog
                .templates()
                .iter()
                .map(SubagentTemplateSummary::from)
                .collect(),
        }
    }
}

impl From<openclaw::projection::subagent_templates::Detail> for SubagentTemplateDetail {
    fn from(detail: openclaw::projection::subagent_templates::Detail) -> Self {
        Self {
            template: SubagentTemplate::from(detail.template()),
        }
    }
}

impl From<&openclaw::projection::subagent_templates::Category> for SubagentTemplateCategory {
    fn from(category: &openclaw::projection::subagent_templates::Category) -> Self {
        Self {
            id: category.id().to_owned(),
            order: category.order(),
        }
    }
}

impl From<&openclaw::projection::subagent_templates::Summary> for SubagentTemplateSummary {
    fn from(summary: &openclaw::projection::subagent_templates::Summary) -> Self {
        Self {
            id: summary.id().to_owned(),
            name: summary.name().to_owned(),
            summary: summary.summary().map(str::to_owned),
            category_id: summary.category_id().map(str::to_owned),
            subcategory_id: summary.subcategory_id().map(str::to_owned),
            order: summary.order(),
            files: summary
                .files()
                .iter()
                .map(|file| file.public_name().to_owned())
                .collect(),
        }
    }
}

impl From<&openclaw::projection::subagent_templates::Template> for SubagentTemplate {
    fn from(template: &openclaw::projection::subagent_templates::Template) -> Self {
        Self {
            summary: SubagentTemplateSummary::from(template.summary()),
            file_contents: template
                .file_contents()
                .iter()
                .map(|(file, content)| (file.public_name().to_owned(), content.clone()))
                .collect(),
        }
    }
}
