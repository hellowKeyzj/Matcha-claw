use super::*;
use crate::domain::{WikiMissingPageCancelInput, WikiMissingPageInput, WikiPageLinks};

impl WikiHandle {
    pub async fn page_links(&self, input: WikiPathSelector) -> Result<WikiPageLinks, WikiFailure> {
        self.request_query(Some("page-links"), |reply| WikiQuery::PageLinks {
            input,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }

    pub(crate) async fn admit_create_missing_page(
        &self,
        mut input: WikiMissingPageInput,
    ) -> Result<CallReceipt, WikiFailure> {
        let operation = WikiCallOperation::CreateMissingPage;
        let call = self
            .begin_admission(operation, &mut input.project_id)
            .await?;
        let plan = self
            .request_query(None, |reply| WikiQuery::StageMissingPage { input, reply })
            .await
            .unwrap_or(Err(WikiFailure::OwnerUnavailable));
        let plan = match plan {
            Ok(plan) => plan,
            Err(error) => {
                call::finish_detail(Some(&call), Some(&error), Some(operation)).await;
                return Err(error);
            }
        };
        self.admit_command(call, operation, true, |reply| {
            WikiCommand::CreateMissingPage { plan, reply }
        })
        .await
    }

    pub async fn cancel_missing_page(
        &self,
        input: WikiMissingPageCancelInput,
    ) -> Result<bool, WikiFailure> {
        self.request_query(Some("missing-page.cancel"), |reply| {
            WikiQuery::CancelMissingPage { input, reply }
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
    }
}
