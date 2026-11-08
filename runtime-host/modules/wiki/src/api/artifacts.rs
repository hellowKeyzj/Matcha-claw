use crate::{
    api::WikiHandle,
    application::commands::{IngestMode, WikiCommand},
    call::{self, WikiCallOperation, WikiWorkflowSummary},
    domain::{WikiArtifactInput, WikiArtifactReceipt, WikiArtifactSelector, WikiFailure},
    owner::artifacts,
};

impl WikiHandle {
    pub(crate) async fn archive_artifact(
        &self,
        input: WikiArtifactInput,
    ) -> Result<WikiArtifactReceipt, WikiFailure> {
        let upload = artifacts::prepare(input).map_err(artifacts::public_failure)?;
        let operation = WikiCallOperation::ArchiveArtifact;
        let call = self
            .begin_admission(operation, &mut Some(upload.selector.project_id.clone()))
            .await?;
        let call_id = call.id().clone();
        let owner = self.unrecorded();
        let (reply, response) = tokio::sync::oneshot::channel();
        // The existing workflow retains both publication and parse/commit after HTTP disconnect.
        self.workflows
            .enqueue(
                Some(call),
                Some(operation),
                None,
                async move {
                    let mut project_id = Some(upload.selector.project_id.clone());
                    let work = match owner.begin_source_work(&mut project_id).await {
                        Ok(work) => work,
                        Err(error) => {
                            let _ = reply.send(Err(error.clone()));
                            return Err(error);
                        }
                    };
                    let staged = owner
                        .request_command(None, |reply| WikiCommand::StageArtifacts {
                            upload,
                            call_id,
                            reply,
                        })
                        .await
                        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
                        .map_err(artifacts::public_failure);
                    let plan = match staged {
                        Ok(plan) => plan,
                        Err(error) => {
                            let _ = reply.send(Err(error.clone()));
                            return owner.finish_source_work(work, Err(error)).await;
                        }
                    };
                    let _ = reply.send(Ok(plan.receipt));
                    let mut failure = None;
                    for staged in plan.imports {
                        if let Err(error) = owner
                            .import_staged_source(staged, &work, IngestMode::SourceOnly)
                            .await
                        {
                            failure.get_or_insert(error);
                        }
                    }
                    owner
                        .finish_source_work(work, failure.map_or(Ok(()), Err))
                        .await
                },
                |_| Some(WikiWorkflowSummary::ProjectImport),
            )
            .await?;
        response
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable))
            .map_err(artifacts::public_failure)
    }

    pub(crate) async fn artifact_status(
        &self,
        input: WikiArtifactSelector,
    ) -> Result<WikiArtifactReceipt, WikiFailure> {
        let call = call::begin(self.recorder(), "artifacts.status").await?;
        let result = async {
            call::running(call.as_ref(), None).await?;
            if self.owner.is_closed() || self.workflows.cancellation.is_cancelled() {
                return Err(WikiFailure::OwnerUnavailable);
            }
            let state = self.shared.snapshot().await;
            self.shared
                .blocking
                .run(move || artifacts::status(&state, input))
                .await
        }
        .await;
        let result = result.map_err(artifacts::public_failure);
        call::finish(call.as_ref(), result.as_ref().err()).await;
        result
    }
}
