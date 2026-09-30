use super::*;
use crate::domain::{WikiArchiveExportInput, WikiArchiveImportInput, WikiRebuildIndexReceipt};

impl WikiHandle {
    pub(crate) async fn admit_export_archive(
        &self,
        mut input: WikiArchiveExportInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ExportArchive;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, false, |reply| WikiCommand::ExportArchive {
            input,
            reply,
        })
        .await
    }

    pub(crate) async fn admit_import_archive(
        &self,
        input: WikiArchiveImportInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ImportArchive;
        let call = self
            .recorder()
            .ok_or(WikiFailure::OwnerUnavailable)?
            .begin(operation.command(), &WikiCallDetail::new(operation))
            .await
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        self.admit_command(call, operation, true, |reply| WikiCommand::ImportArchive {
            input,
            reply,
        })
        .await
    }

    pub(crate) async fn admit_rebuild_index(
        &self,
        mut input: WikiProjectSelector,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::RebuildIndex;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, true, |reply| WikiCommand::RebuildIndex {
            input,
            reply,
        })
        .await
    }

    pub async fn rebuild_index(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiRebuildIndexReceipt, WikiFailure> {
        self.request_command(Some("rebuild-index"), |reply| WikiCommand::RebuildIndex {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }
}
