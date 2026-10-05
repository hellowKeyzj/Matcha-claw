use super::*;
use crate::sweep::SourceWork;

impl WikiHandle {
    pub(super) async fn begin_source_work(
        &self,
        project_id: &mut Option<String>,
    ) -> Result<SourceWork, WikiFailure> {
        self.resolve_current_project(project_id).await?;
        self.request_command(None, |reply| WikiCommand::BeginSourceWork {
            project_id: project_id
                .clone()
                .expect("source project resolved before dispatch"),
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(super) async fn finish_source_work<T>(
        &self,
        work: SourceWork,
        result: Result<T, WikiFailure>,
    ) -> Result<T, WikiFailure> {
        let project_id = work.project_id().to_owned();
        drop(work);
        if self.sweep_reviews_after_drain(project_id).await.is_err() {
            eprintln!("[wiki] review cleanup failed; source result retained");
        }
        result
    }

    async fn sweep_reviews_after_drain(&self, project_id: String) -> Result<(), WikiFailure> {
        let plan = self
            .request_command(None, |reply| WikiCommand::StageReviewSweep {
                project_id,
                reply,
            })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))?;
        let Some(plan) = plan else { return Ok(()) };
        let resolved_ids = crate::sweep::judge(&plan).await;
        self.request_command(None, |reply| WikiCommand::CompleteReviewSweep {
            plan,
            resolved_ids,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }
}
