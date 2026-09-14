use std::{fmt, sync::Arc};

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub use crate::gateway::wire::agents::{
    AgentCreate, AgentCreated, AgentDelete, AgentDeleted, AgentFile, AgentFileName, AgentFiles,
    AgentKind, AgentModelUpdate, AgentSummary, AgentUpdate, AgentUpdated, AgentWait,
    AgentWaitResult, AgentWaitStatus, AgentsList,
};

pub(crate) struct OpenClawAgents {
    gateway: Arc<GatewayClient>,
}

impl OpenClawAgents {
    pub(crate) fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub(crate) async fn list(&self) -> Result<AgentsList, AgentsReadFailure> {
        let request = wire::agents::list_request(next_request_id("list"))
            .map_err(|_| AgentsReadFailure::Protocol)?;
        self.read(
            request,
            &[wire::agents::AGENTS_LIST_METHOD],
            wire::agents::decode_list,
        )
        .await
    }

    pub(crate) async fn files_list(
        &self,
        agent_id: String,
    ) -> Result<AgentFiles, AgentsReadFailure> {
        let request =
            wire::agents::files_list_request(next_request_id("files-list"), agent_id.clone())
                .map_err(|_| AgentsReadFailure::Rejected)?;
        self.read(
            request,
            &[wire::agents::AGENTS_FILES_LIST_METHOD],
            move |response| wire::agents::decode_files_list(response, &agent_id),
        )
        .await
    }

    pub(crate) async fn files_get(
        &self,
        agent_id: String,
        name: AgentFileName,
    ) -> Result<AgentFile, AgentsReadFailure> {
        let request =
            wire::agents::files_get_request(next_request_id("files-get"), agent_id.clone(), name)
                .map_err(|_| AgentsReadFailure::Rejected)?;
        self.read(
            request,
            &[wire::agents::AGENTS_FILES_GET_METHOD],
            move |response| wire::agents::decode_files_get(response, &agent_id, name),
        )
        .await
    }

    pub(crate) async fn wait(&self, input: AgentWait) -> AgentsWaitOutcome {
        let run_id = input.run_id().to_owned();
        let rpc_deadline_ms = input.rpc_deadline_ms();
        let request = match wire::agents::wait_request(next_request_id("wait"), input) {
            Ok(request) => request,
            Err(_) => return AgentsWaitOutcome::Rejected,
        };
        let response = self
            .gateway
            .rpc_query_with_deadline(request, std::time::Duration::from_millis(rpc_deadline_ms))
            .await;
        match response {
            Ok(GatewayResponse::Failure { .. }) => AgentsWaitOutcome::Rejected,
            Ok(response) => wire::agents::decode_wait(response, &run_id)
                .map(AgentsWaitOutcome::Observed)
                .unwrap_or(AgentsWaitOutcome::OutcomeUnknown),
            Err(_) => AgentsWaitOutcome::OutcomeUnknown,
        }
    }

    pub(crate) async fn create(&self, input: AgentCreate) -> AgentsMutationOutcome<AgentCreated> {
        let request = match wire::agents::create_request(next_request_id("create"), input) {
            Ok(request) => request,
            Err(_) => return AgentsMutationOutcome::Rejected,
        };
        self.mutate(
            request,
            wire::agents::AGENTS_CREATE_METHOD,
            wire::agents::decode_create,
        )
        .await
    }

    pub(crate) async fn update(&self, input: AgentUpdate) -> AgentsMutationOutcome<AgentUpdated> {
        let request = match wire::agents::update_request(next_request_id("update"), input) {
            Ok(request) => request,
            Err(_) => return AgentsMutationOutcome::Rejected,
        };
        self.mutate(
            request,
            wire::agents::AGENTS_UPDATE_METHOD,
            wire::agents::decode_update,
        )
        .await
    }

    pub(crate) async fn delete(&self, input: AgentDelete) -> AgentsMutationOutcome<AgentDeleted> {
        let request = match wire::agents::delete_request(next_request_id("delete"), input) {
            Ok(request) => request,
            Err(_) => return AgentsMutationOutcome::Rejected,
        };
        self.mutate(
            request,
            wire::agents::AGENTS_DELETE_METHOD,
            wire::agents::decode_delete,
        )
        .await
    }

    pub(crate) async fn files_set(
        &self,
        agent_id: String,
        name: AgentFileName,
        content: String,
    ) -> AgentsMutationOutcome<AgentFile> {
        let request = match wire::agents::files_set_request(
            next_request_id("files-set"),
            agent_id.clone(),
            name,
            content,
        ) {
            Ok(request) => request,
            Err(_) => return AgentsMutationOutcome::Rejected,
        };
        self.mutate(
            request,
            wire::agents::AGENTS_FILES_SET_METHOD,
            move |response| wire::agents::decode_files_set(response, &agent_id, name),
        )
        .await
    }

    async fn read<T>(
        &self,
        request: wire::RpcRequest,
        _methods: &[&str],
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, AgentsReadFailure> {
        match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(AgentsReadFailure::Rejected),
            Ok(response) => decode(response).map_err(|_| AgentsReadFailure::Protocol),
            Err(error) => Err(map_read_connection_failure(error)),
        }
    }

    async fn mutate<T>(
        &self,
        request: wire::RpcRequest,
        method: &str,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> AgentsMutationOutcome<T> {
        let _ = method;
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                AgentsMutationOutcome::Rejected
            }
            MutationDelivery::Response(response) => match decode(response) {
                Ok(value) => AgentsMutationOutcome::Applied(value),
                Err(_) => AgentsMutationOutcome::OutcomeUnknown,
            },
            MutationDelivery::NotWritten(_) => AgentsMutationOutcome::Rejected,
            MutationDelivery::MayHaveReached(_) => AgentsMutationOutcome::OutcomeUnknown,
        }
    }
}

impl fmt::Debug for OpenClawAgents {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawAgents")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentsReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AgentsWaitOutcome {
    Observed(AgentWaitResult),
    Rejected,
    OutcomeUnknown,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AgentsMutationOutcome<T> {
    Applied(T),
    Rejected,
    OutcomeUnknown,
}

fn map_read_connection_failure(error: GatewayClientError) -> AgentsReadFailure {
    match error {
        GatewayClientError::Protocol | GatewayClientError::RpcFailed => AgentsReadFailure::Protocol,
        _ => AgentsReadFailure::Unavailable,
    }
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("agents-{operation}-{sequence}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn mutation_decode_failure_is_outcome_unknown() {
        let response = crate::gateway::wire::decode_response(
            &json!({"type": "res", "id": "test", "ok": true, "payload": {}}).to_string(),
            "test",
        )
        .unwrap()
        .unwrap();

        let outcome = match MutationDelivery::Response(response) {
            MutationDelivery::Response(response) => wire::agents::decode_create(response)
                .map(AgentsMutationOutcome::Applied)
                .unwrap_or(AgentsMutationOutcome::OutcomeUnknown),
            _ => unreachable!(),
        };
        assert!(matches!(outcome, AgentsMutationOutcome::OutcomeUnknown));
    }
}
