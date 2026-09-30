use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallRecorder, CallStatus};
use tokio::sync::oneshot;

use crate::{
    PlatformToolsCallDetail, PlatformToolsCallResult, PlatformToolsOutcome,
    application::commands::{PlatformToolsCommand, PlatformToolsQuery},
};

#[derive(Clone)]
pub struct PlatformToolsModule {
    owner: OwnerRuntimeHandle<PlatformToolsCommand, PlatformToolsQuery>,
    recorder: Option<CallRecorder>,
}

impl PlatformToolsModule {
    pub(crate) fn new(owner: OwnerRuntimeHandle<PlatformToolsCommand, PlatformToolsQuery>) -> Self {
        Self {
            owner,
            recorder: None,
        }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub async fn platform_tools(&self) -> PlatformToolsOutcome {
        let call = match &self.recorder {
            Some(recorder) => recorder
                .begin("catalogList", &PlatformToolsCallDetail::default())
                .await
                .ok(),
            None => None,
        };
        let (reply, response) = oneshot::channel();
        if self
            .owner
            .send_query(PlatformToolsQuery::List {
                reply,
                call: call.clone(),
            })
            .await
            .is_err()
        {
            if let Some(call) = call {
                let _ = call
                    .finish(
                        CallStatus::Rejected,
                        &PlatformToolsCallDetail {
                            result: Some(PlatformToolsCallResult::Rejected),
                            ..Default::default()
                        },
                    )
                    .await;
            }
            return PlatformToolsOutcome::Unavailable;
        }
        if let Some(call) = call {
            let _ = call.accepted().await;
        }
        response.await.unwrap_or(PlatformToolsOutcome::Unavailable)
    }
}
