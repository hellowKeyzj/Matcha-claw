use std::{path::PathBuf, sync::Arc};

use super::OpenClawSkillProvider;
use crate::{driver::OpenClawDriver, port::OpenClawDriverParentCallbackHandle};

impl OpenClawDriver {
    fn skill_provider(&self) -> OpenClawSkillProvider {
        OpenClawSkillProvider::new(
            Arc::clone(&self.gateway),
            self.electron_image.clone(),
            self.working_directory.clone(),
            self.state_dir.clone(),
        )
    }
}

async fn open_parent_path(
    parent_callback: OpenClawDriverParentCallbackHandle,
    path: PathBuf,
) -> bool {
    parent_callback.open_path(path).await
}

impl skills_module::SkillRuntimeOps for OpenClawDriver {
    fn installed_skill_names<'a>(
        &'a self,
    ) -> skills_module::ports::SkillsFuture<'a, Option<Vec<String>>> {
        let provider = self.skill_provider();
        Box::pin(async move {
            provider
                .installed_skill_catalog()
                .await
                .map(|catalog| catalog.names().iter().cloned().collect())
        })
    }

    fn install_clawhub_skill<'a>(
        &'a self,
        command: skills_module::install::Command,
    ) -> skills_module::ports::SkillsFuture<'a, skills_module::install::Outcome> {
        Box::pin(async move { self.skill_provider().install_clawhub(command).await })
    }

    fn skill_status<'a>(
        &'a self,
    ) -> skills_module::ports::SkillsFuture<'a, skills_module::status::Outcome> {
        Box::pin(async move { self.skill_provider().status().await })
    }

    fn manage_skills<'a>(
        &'a self,
        command: skills_module::management::Command,
    ) -> skills_module::ports::SkillsFuture<'a, skills_module::management::Outcome> {
        Box::pin(async move {
            let parent_callback = self.parent_callback.clone();
            self.skill_provider()
                .manage(command, move |path| open_parent_path(parent_callback, path))
                .await
        })
    }

    fn skill_bundles<'a>(
        &'a self,
        command: skills_module::bundle::Command,
    ) -> skills_module::ports::SkillsFuture<'a, skills_module::bundle::Outcome> {
        Box::pin(async move { self.skill_provider().bundles(command).await })
    }
}
