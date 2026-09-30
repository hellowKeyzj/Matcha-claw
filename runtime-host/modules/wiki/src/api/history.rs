use super::*;
use crate::history::{
    WikiFileHistoryInput, WikiFileHistoryReceipt, WikiFileHistorySettings,
    WikiFileHistorySettingsInput, WikiFileHistoryStats, WikiRestoreFileHistoryInput,
};

impl WikiHandle {
    pub async fn history_list(
        &self,
        input: WikiFileHistoryInput,
    ) -> Result<WikiFileHistoryReceipt, WikiFailure> {
        self.request_query(Some("history.list"), |reply| WikiQuery::HistoryList {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn history_config(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiFileHistorySettings, WikiFailure> {
        self.request_query(Some("history.config"), |reply| WikiQuery::HistoryConfig {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn history_stats(
        &self,
        input: WikiProjectSelector,
    ) -> Result<WikiFileHistoryStats, WikiFailure> {
        self.request_query(Some("history.stats"), |reply| WikiQuery::HistoryStats {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub async fn update_history_config(
        &self,
        input: WikiFileHistorySettingsInput,
    ) -> Result<WikiFileHistorySettings, WikiFailure> {
        self.request_command(Some("history.config.update"), |reply| {
            WikiCommand::UpdateHistoryConfig { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_restore_history(
        &self,
        mut input: WikiRestoreFileHistoryInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::RestoreHistory;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, false, |reply| {
            WikiCommand::RestoreHistory { input, reply }
        })
        .await
    }

    pub async fn restore_history(
        &self,
        input: WikiRestoreFileHistoryInput,
    ) -> Result<WikiReadReceipt, WikiFailure> {
        self.request_command(Some("history.restore"), |reply| {
            WikiCommand::RestoreHistory { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_clear_history(
        &self,
        mut input: WikiProjectSelector,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::ClearHistory;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        self.admit_command(call, operation, false, |reply| WikiCommand::ClearHistory {
            input,
            reply,
        })
        .await
    }
}
