use serde_json::{Value, json};

use super::{
    definition::Definition,
    store::{Receipt, Store},
};
use crate::{
    diagnostics::Diagnostics,
    events::Events,
    rpc::{self, Error},
    session::Sessions,
};

pub(super) async fn submit(
    store: &Store,
    sessions: &Sessions,
    definition: &Definition,
    mut receipt: Receipt,
) -> rpc::Result<Receipt> {
    let session_id = receipt
        .session_id
        .as_deref()
        .ok_or_else(|| Error::internal("schedule_session_missing"))?;
    let prepared = async {
        let session = if definition.session_id.is_some() {
            sessions
                .dispatch("sessions.get", json!({"sessionId":session_id}))
                .await?
        } else {
            sessions
                .dispatch(
                    "sessions.create",
                    json!({"agentId":definition.agent_id,"sessionId":session_id,"model":definition.model}),
                )
                .await?
        };
        if session.get("agentId").and_then(Value::as_str) != Some(&definition.agent_id) {
            return Err(Error::conflict(
                "schedule_session_agent",
                "The target session belongs to another Agent",
            ));
        }
        if session.get("model").and_then(Value::as_str) != definition.model.as_deref() {
            return Err(Error::conflict(
                "schedule_session_model",
                "The target session has a different model override; use a schedule-owned session or align the native model explicitly",
            ));
        }
        if session.get("status").and_then(Value::as_str) != Some("open") {
            return Err(Error::conflict(
                "schedule_session_closed",
                "Resume the target session before scheduling another run",
            ));
        }
        Ok(())
    }
    .await;
    let result = match prepared {
        Ok(()) => {
            sessions
                .submit(session_id, Value::String(definition.prompt.clone()))
                .await
        }
        Err(error) => {
            // Preparation cannot have submitted a prompt, even if session creation committed.
            receipt.status = "rejected".into();
            receipt.reason = Some(error_kind(&error));
            receipt.completed_at_ms = Some(rpc::now_ms());
            store
                .settle(
                    &receipt.receipt_id,
                    &receipt.status,
                    None,
                    receipt.reason.clone(),
                )
                .await?;
            return Ok(receipt);
        }
    };
    match result {
        Ok(run_id) => {
            receipt.status = "submitted".into();
            receipt.run_id = Some(run_id);
        }
        Err(error) => {
            receipt.status = if matches!(error.code, -32602 | -32001 | -32002 | -32003) {
                "rejected"
            } else {
                "outcomeUnknown"
            }
            .into();
            receipt.reason = Some(error_kind(&error));
            receipt.completed_at_ms = Some(rpc::now_ms());
        }
    }
    store.settle(&receipt.receipt_id, &receipt.status, receipt.run_id.clone(), receipt.reason.clone()).await.map_err(|error| {
        Error::new(-32006, "schedule_receipt_commit_unknown", "The run may have been submitted, but its schedule receipt could not be committed; do not retry this receipt")
            .with_data(json!({"receiptId":receipt.receipt_id,"runId":receipt.run_id,"storageCode":error.code})).with_source(error)
    })?;
    Ok(receipt)
}

fn error_kind(error: &Error) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("schedule_submission_failed")
        .to_owned()
}

pub(super) async fn publish(receipt: &Receipt, events: &Events, diagnostics: &Diagnostics) {
    if let Some(session_id) = &receipt.session_id
        && let Err(error) = events.append(session_id, receipt.run_id.as_deref(), "schedule.receipt", json!({
            "scheduleId":receipt.schedule_id,"receiptId":receipt.receipt_id,"trigger":receipt.trigger,
            "dueAtMs":receipt.due_at_ms,"status":receipt.status,"reason":receipt.reason,
        })).await
    {
        report(diagnostics, "event", &error).await;
    }
}

pub(super) async fn reconcile(
    store: &Store,
    sessions: &Sessions,
    events: &Events,
    diagnostics: &Diagnostics,
) -> rpc::Result<()> {
    for mut receipt in store.pending().await? {
        let Some(run_id) = &receipt.run_id else {
            return Err(Error::internal("schedule_submitted_without_run"));
        };
        match sessions.dispatch("runs.get", json!({"runId":run_id})).await {
            Ok(run) => {
                let status = run
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::internal("schedule_run_status_missing"))?;
                match status {
                    "queued" | "starting" | "running" | "cancelRequested" => continue,
                    "succeeded" | "failed" | "cancelled" | "outcomeUnknown" => {
                        receipt.status = status.into()
                    }
                    _ => {
                        return Err(Error::unavailable(
                            "schedule_run_status_unsupported",
                            "The execution backend returned an unsupported Run state",
                        ));
                    }
                }
            }
            Err(error) if error.code == -32001 => {
                receipt.status = "outcomeUnknown".into();
                receipt.reason = Some("run_not_found".into());
            }
            Err(error) => {
                report(diagnostics, "observe_run", &error).await;
                continue;
            }
        }
        receipt.completed_at_ms = Some(rpc::now_ms());
        store
            .settle(
                &receipt.receipt_id,
                &receipt.status,
                None,
                receipt.reason.clone(),
            )
            .await?;
        publish(&receipt, events, diagnostics).await;
    }
    Ok(())
}

pub(super) async fn report(diagnostics: &Diagnostics, operation: &str, error: &Error) {
    if diagnostics
        .record(
            "schedule",
            operation,
            &error_kind(error),
            json!({"code":error.code}),
        )
        .await
        .is_err()
    {
        eprintln!("schedule diagnostic could not be committed");
    }
}
