mod observer;
mod projection;

pub use observer::observe_receipts;

use std::time::Duration;

use ::cron::{ports::CronFuture, *};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    client::{Client, Delivery, Error},
    driver::MatchaRuntimeDriver,
};
use projection::Receipt;

impl CronOps for MatchaRuntimeDriver {
    fn list_cron_jobs<'a>(&'a self) -> CronFuture<'a, CronListOutcome> {
        Box::pin(async move {
            match self.native_client().call("schedules.list", json!({})).await {
                Ok(value) => {
                    let Some(schedules) = value.get("schedules").and_then(Value::as_array) else {
                        return CronListOutcome::Protocol;
                    };
                    // Unnamed native schedules have no product creation metadata; do not invent a UI job.
                    let jobs = schedules
                        .iter()
                        .filter(|value| {
                            value
                                .pointer("/definition/name")
                                .is_some_and(Value::is_string)
                        })
                        .cloned()
                        .map(projection::job)
                        .collect::<Result<Vec<_>, _>>();
                    match jobs {
                        Ok(jobs) => CronListOutcome::Listed(CronListView { jobs }),
                        Err(()) => CronListOutcome::Protocol,
                    }
                }
                Err(error) if rejected(&error) => CronListOutcome::Rejected,
                Err(_) => CronListOutcome::Unavailable,
            }
        })
    }

    fn load_cron_history<'a>(
        &'a self,
        command: &'a CronHistoryCommand,
    ) -> CronFuture<'a, Option<Result<CronHistoryView, CronRunHistoryFailure>>> {
        Box::pin(async move { Some(load_history(self.native_client(), command).await) })
    }

    fn cron_run_history<'a>(
        &'a self,
        job_id: String,
        limit: u64,
    ) -> CronFuture<'a, Result<Vec<CronRunHistoryReceipt>, CronRunHistoryFailure>> {
        Box::pin(async move {
            let receipts = history(&self.native_client(), &job_id, limit).await?;
            Ok(receipts
                .into_iter()
                .map(|receipt| {
                    CronRunHistoryReceipt::new(receipt.schedule_id, receipt.session_id, None)
                })
                .collect())
        })
    }

    fn admit_cron_execution<'a>(
        &'a self,
        job_id: String,
    ) -> CronFuture<'a, Result<Result<CronExecutionAdmission, CronTriggerResult>, ()>> {
        Box::pin(async move {
            let client = self.native_client();
            let value = match client.call("schedules.run", json!({"id":job_id})).await {
                Ok(value) => value,
                Err(error) => {
                    return Ok(Err(if mutation_unknown(&error) {
                        CronTriggerResult::OutcomeUnknown
                    } else if rejected(&error) {
                        CronTriggerResult::Rejected
                    } else {
                        CronTriggerResult::Unavailable
                    }));
                }
            };
            let receipt: Receipt = serde_json::from_value(value).map_err(|_| ())?;
            if receipt.schedule_id != job_id {
                return Ok(Err(CronTriggerResult::OutcomeUnknown));
            }
            match receipt.status.as_str() {
                "submitted" => {
                    let run_id = receipt.run_id.ok_or(())?;
                    let session_id = receipt.session_id.ok_or(())?;
                    CronExecutionAdmission::new(
                        run_id.clone(),
                        Waiter {
                            client,
                            run_id,
                            session_id,
                        },
                    )
                    .map(Ok)
                    .map_err(|_| ())
                }
                "rejected" => Ok(Err(CronTriggerResult::Rejected)),
                _ => Ok(Err(CronTriggerResult::OutcomeUnknown)),
            }
        })
    }

    fn add_cron_job<'a>(
        &'a self,
        command: CronCreateCommand,
    ) -> CronFuture<'a, CronJobMutationOutcome> {
        Box::pin(async move {
            mutation(
                self.native_client()
                    .call("schedules.create", projection::create(command))
                    .await,
            )
        })
    }

    fn update_cron_job<'a>(
        &'a self,
        command: CronUpdateCommand,
    ) -> CronFuture<'a, CronJobMutationOutcome> {
        Box::pin(async move {
            let client = self.native_client();
            let current = match client
                .call("schedules.get", json!({"id":command.job_id,"limit":0}))
                .await
            {
                Ok(current) => current,
                Err(error) => {
                    return if rejected(&error) {
                        CronJobMutationOutcome::Rejected
                    } else {
                        CronJobMutationOutcome::Unavailable
                    };
                }
            };
            let params = match projection::update(&current, command) {
                Ok(params) => params,
                Err(()) => return CronJobMutationOutcome::Rejected,
            };
            mutation(client.call("schedules.update", params).await)
        })
    }

    fn delete_cron_job<'a>(
        &'a self,
        command: CronDeleteCommand,
    ) -> CronFuture<'a, CronDeleteOutcome> {
        Box::pin(async move {
            let client = self.native_client();
            let current = match client
                .call("schedules.get", json!({"id":command.job_id,"limit":0}))
                .await
            {
                Ok(current) => current,
                Err(error) => {
                    return if rejected(&error) {
                        CronDeleteOutcome::Rejected
                    } else {
                        CronDeleteOutcome::Unavailable
                    };
                }
            };
            let Some(revision) = current.get("revision").and_then(Value::as_str) else {
                return CronDeleteOutcome::Unavailable;
            };
            match client
                .call(
                    "schedules.delete",
                    json!({"id":command.job_id,"expectedRevision":revision}),
                )
                .await
            {
                Ok(value)
                    if value.get("id").and_then(Value::as_str) == Some(&command.job_id)
                        && value.get("deleted").and_then(Value::as_bool) == Some(true)
                        && value.get("submittedRunsCancelled").and_then(Value::as_bool)
                            == Some(false)
                        && value.get("receiptsRetained").and_then(Value::as_bool) == Some(true) =>
                {
                    CronDeleteOutcome::Applied(CronRemovedView { removed: true })
                }
                Ok(_) => CronDeleteOutcome::OutcomeUnknown,
                Err(error) if mutation_unknown(&error) => CronDeleteOutcome::OutcomeUnknown,
                Err(error) if rejected(&error) => CronDeleteOutcome::Rejected,
                Err(_) => CronDeleteOutcome::Unavailable,
            }
        })
    }
}

fn mutation(result: Result<Value, Error>) -> CronJobMutationOutcome {
    match result {
        Ok(value) => match projection::job(value) {
            Ok(job) => CronJobMutationOutcome::Applied(Box::new(job)),
            Err(()) => CronJobMutationOutcome::OutcomeUnknown,
        },
        Err(error) if mutation_unknown(&error) => CronJobMutationOutcome::OutcomeUnknown,
        Err(error) if error.kind() == "schedule_delivery_unsupported" => {
            CronJobMutationOutcome::UnsupportedDelivery
        }
        Err(error) if rejected(&error) => CronJobMutationOutcome::Rejected,
        Err(_) => CronJobMutationOutcome::Unavailable,
    }
}

fn rejected(error: &Error) -> bool {
    matches!(error.code(), Some(-32602 | -32001 | -32002))
        || matches!(
            error.kind(),
            "schedule_delivery_unsupported" | "schedule_session_model"
        )
}

fn mutation_unknown(error: &Error) -> bool {
    error.delivery() == Delivery::Unknown
        || error.code() == Some(-32006)
        || error
            .data()
            .and_then(|data| data.get("configurationCommitted"))
            .and_then(Value::as_bool)
            == Some(true)
}

struct Waiter {
    client: Client,
    run_id: String,
    session_id: String,
}

impl CronExecutionWaiter for Waiter {
    fn await_terminal(
        self: Box<Self>,
        cancellation: CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CronExecutionTerminalStatus> + Send>>
    {
        Box::pin(async move {
            loop {
                let result = self
                    .client
                    .call_cancellable("runs.get", json!({"runId":self.run_id}), &cancellation)
                    .await;
                match result {
                    Ok(run) => {
                        if run.get("runId").and_then(Value::as_str) != Some(&self.run_id)
                            || run.get("sessionId").and_then(Value::as_str)
                                != Some(&self.session_id)
                        {
                            return CronExecutionTerminalStatus::OutcomeUnknown;
                        }
                        match run.get("status").and_then(Value::as_str) {
                            Some("succeeded") => return CronExecutionTerminalStatus::Succeeded,
                            Some("failed") => return CronExecutionTerminalStatus::Failed,
                            Some("cancelled") => return CronExecutionTerminalStatus::Cancelled,
                            Some("outcomeUnknown") => {
                                return CronExecutionTerminalStatus::OutcomeUnknown;
                            }
                            Some("queued" | "starting" | "running" | "cancelRequested") => {}
                            _ => return CronExecutionTerminalStatus::OutcomeUnknown,
                        }
                    }
                    // Cancelling Host observation never cancels an already submitted native Run.
                    Err(_) => return CronExecutionTerminalStatus::OutcomeUnknown,
                }
                tokio::select! {
                    _ = cancellation.cancelled() => return CronExecutionTerminalStatus::OutcomeUnknown,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
            }
        })
    }
}

async fn history(
    client: &Client,
    id: &str,
    limit: u64,
) -> Result<Vec<Receipt>, CronRunHistoryFailure> {
    let value = client
        .call("schedules.history", json!({"id":id,"limit":limit}))
        .await
        .map_err(read_failure)?;
    if value.get("id").and_then(Value::as_str) != Some(id) {
        return Err(CronRunHistoryFailure::Protocol);
    }
    let receipts: Vec<Receipt> = serde_json::from_value(
        value
            .get("receipts")
            .cloned()
            .ok_or(CronRunHistoryFailure::Protocol)?,
    )
    .map_err(|_| CronRunHistoryFailure::Protocol)?;
    if receipts
        .iter()
        .any(|receipt| receipt.schedule_id != id || receipt.receipt_id.is_empty())
    {
        return Err(CronRunHistoryFailure::Protocol);
    }
    Ok(receipts)
}

fn read_failure(error: Error) -> CronRunHistoryFailure {
    if rejected(&error) {
        CronRunHistoryFailure::Rejected
    } else {
        CronRunHistoryFailure::Unavailable
    }
}

async fn load_history(
    client: Client,
    command: &CronHistoryCommand,
) -> Result<CronHistoryView, CronRunHistoryFailure> {
    let receipts = history(&client, command.job_id(), command.limit()).await?;
    let mut sessions = std::collections::BTreeSet::new();
    let mut messages = Vec::new();
    for receipt in receipts.into_iter().rev() {
        if matches!(receipt.status.as_str(), "missed" | "rejected") {
            continue;
        }
        let Some(session_id) = receipt.session_id else {
            continue;
        };
        if command
            .run_session_id()
            .is_some_and(|expected| expected != session_id)
            || !sessions.insert(session_id.clone())
        {
            continue;
        }
        let session = client
            .call(
                "sessions.get",
                json!({"sessionId":session_id,"history":true,"limit":command.limit()}),
            )
            .await
            .map_err(read_failure)?;
        if session.get("sessionId").and_then(Value::as_str) != Some(&session_id)
            || session.get("agentId").and_then(Value::as_str) != Some(command.agent_id())
        {
            return Err(CronRunHistoryFailure::Rejected);
        }
        let history = session
            .get("history")
            .ok_or(CronRunHistoryFailure::Protocol)?;
        let total = history
            .get("total")
            .and_then(Value::as_u64)
            .ok_or(CronRunHistoryFailure::Protocol)?;
        let latest = if total > command.limit() {
            client.call("sessions.get", json!({"sessionId":session_id,"history":true,"offset":total-command.limit(),"limit":command.limit()})).await.map_err(read_failure)?
        } else {
            session
        };
        if latest.get("sessionId").and_then(Value::as_str) != Some(&session_id)
            || latest.get("agentId").and_then(Value::as_str) != Some(command.agent_id())
        {
            return Err(CronRunHistoryFailure::Rejected);
        }
        let items = latest
            .pointer("/history/messages")
            .and_then(Value::as_array)
            .ok_or(CronRunHistoryFailure::Protocol)?;
        for item in items {
            let Some(message) = item.get("message") else {
                continue;
            };
            let role = match message.get("role").and_then(Value::as_str) {
                Some("user") => CronHistoryRole::User,
                Some("assistant") => CronHistoryRole::Assistant,
                _ => continue,
            };
            let text = match message.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => return Err(CronRunHistoryFailure::Protocol),
            };
            if !text.is_empty() {
                messages.push(CronHistoryMessageView { role, text });
            }
        }
    }
    if command.run_session_id().is_some() && sessions.is_empty() {
        return Err(CronRunHistoryFailure::Rejected);
    }
    let limit = usize::try_from(command.limit()).map_err(|_| CronRunHistoryFailure::Protocol)?;
    if messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }
    Ok(CronHistoryView { messages })
}
