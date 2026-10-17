use serde::Deserialize;
use serde_json::{Value, json};

use ::cron::{
    CronCreateCommand, CronDeliveryCommand, CronDeliveryView, CronJobStateView, CronJobView,
    CronRunStatusView, CronScheduleCommand, CronScheduleView, CronUpdateCommand,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub receipt_id: String,
    pub schedule_id: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub observed_at_ms: u64,
    pub completed_at_ms: Option<u64>,
    pub status: String,
    pub reason: Option<String>,
}

pub(super) fn schedule(command: &CronScheduleCommand) -> Value {
    match command {
        CronScheduleCommand::Cron { expr, tz } => json!({"kind":"cron","expr":expr,"tz":tz}),
        CronScheduleCommand::At { at } => json!({"kind":"at","at":at}),
        CronScheduleCommand::Every {
            every_ms,
            anchor_ms,
        } => json!({"kind":"every","everyMs":every_ms,"anchorMs":anchor_ms}),
    }
}

fn delivery(command: &CronDeliveryCommand) -> Value {
    match command {
        CronDeliveryCommand::None => json!({"mode":"none"}),
        CronDeliveryCommand::Announce {
            channel,
            to,
            account_id,
        } => json!({"mode":"announce","channel":channel,"to":to,"accountId":account_id}),
    }
}

pub(super) fn create(command: CronCreateCommand) -> Value {
    json!({
        "name":command.name,"agentId":command.agent_id,"prompt":command.message,"model":command.model,
        "schedule":schedule(&command.schedule),"delivery":delivery(&command.delivery),
        "enabled":command.enabled,"recurring":!matches!(command.schedule, CronScheduleCommand::At { .. }),
    })
}

pub(super) fn update(current: &Value, command: CronUpdateCommand) -> Result<Value, ()> {
    let revision = current.get("revision").and_then(Value::as_str).ok_or(())?;
    if command
        .expected_config_revision
        .as_deref()
        .is_some_and(|expected| expected != revision)
    {
        return Err(());
    }
    let mut definition = current
        .get("definition")
        .and_then(Value::as_object)
        .cloned()
        .ok_or(())?;
    definition.remove("createdAtMs");
    definition.remove("updatedAtMs");
    definition.insert("id".into(), Value::String(command.job_id));
    definition.insert("expectedRevision".into(), Value::String(revision.into()));
    if let Some(value) = command.name {
        definition.insert("name".into(), value.into());
    }
    if let Some(value) = command.agent_id {
        definition.insert("agentId".into(), value.into());
    }
    if let Some(value) = command.message {
        definition.insert("prompt".into(), value.into());
    }
    if let Some(value) = command.model {
        definition.insert("model".into(), json!(value));
    }
    if let Some(value) = command.enabled {
        definition.insert("enabled".into(), value.into());
    }
    if let Some(value) = command.delivery {
        definition.insert("delivery".into(), delivery(&value));
    }
    if let Some(value) = command.schedule {
        definition.remove("cron");
        definition.insert(
            "recurring".into(),
            (!matches!(value, CronScheduleCommand::At { .. })).into(),
        );
        definition.insert("schedule".into(), schedule(&value));
    }
    Ok(Value::Object(definition))
}

pub(super) fn job(value: Value) -> Result<CronJobView, ()> {
    let definition = value.get("definition").ok_or(())?;
    let state = value.get("state").ok_or(())?;
    let schedule = definition.get("schedule").ok_or(())?;
    let schedule = match text(schedule, "kind")? {
        "at" => CronScheduleView::At {
            at: text(schedule, "at")?.into(),
        },
        "every" => CronScheduleView::Every {
            every_ms: schedule.get("everyMs").and_then(Value::as_u64).ok_or(())?,
            anchor_ms: optional_u64(schedule, "anchorMs")?,
        },
        "cron" => CronScheduleView::Cron {
            expr: text(schedule, "expr")?.into(),
            tz: optional_text(schedule, "tz")?,
        },
        _ => return Err(()),
    };
    let delivery = match definition
        .get("delivery")
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
    {
        Some("none") => CronDeliveryView::None,
        Some("announce") => {
            let delivery = &definition["delivery"];
            CronDeliveryView::Announce {
                channel: text(delivery, "channel")?.into(),
                to: text(delivery, "to")?.into(),
                account_id: text(delivery, "accountId")?.into(),
            }
        }
        _ => return Err(()),
    };
    let receipt = value
        .get("lastFinishedReceipt")
        .filter(|receipt| !receipt.is_null())
        .map(|receipt| serde_json::from_value::<Receipt>(receipt.clone()).map_err(|_| ()))
        .transpose()?;
    let running = value
        .get("runningReceipt")
        .filter(|receipt| !receipt.is_null())
        .map(|receipt| serde_json::from_value::<Receipt>(receipt.clone()).map_err(|_| ()))
        .transpose()?;
    let terminal = receipt
        .as_ref()
        .filter(|receipt| !matches!(receipt.status.as_str(), "dispatching" | "submitted"));
    let last_status = terminal
        .map(|receipt| match receipt.status.as_str() {
            "succeeded" => Ok(CronRunStatusView::Ok),
            "failed" | "rejected" | "cancelled" | "outcomeUnknown" => Ok(CronRunStatusView::Error),
            "missed" => Ok(CronRunStatusView::Skipped),
            _ => Err(()),
        })
        .transpose()?;
    Ok(CronJobView {
        id: text(&value, "id")?.into(),
        name: text(definition, "name")?.into(),
        agent_id: Some(text(definition, "agentId")?.into()),
        message: Some(text(definition, "prompt")?.into()),
        model: optional_text(definition, "model")?,
        schedule,
        delivery,
        enabled: definition
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or(())?,
        system_managed: false,
        created_at_ms: definition
            .get("createdAtMs")
            .and_then(Value::as_u64)
            .ok_or(())?,
        updated_at_ms: definition
            .get("updatedAtMs")
            .and_then(Value::as_u64)
            .ok_or(())?,
        state: CronJobStateView {
            next_run_at_ms: optional_u64(state, "nextFireMs")?,
            running_at_ms: running.as_ref().map(|receipt| receipt.observed_at_ms),
            last_run_at_ms: terminal.map(|receipt| receipt.observed_at_ms),
            last_run_status: last_status,
            last_error: terminal
                .filter(|receipt| receipt.status != "succeeded")
                .map(|receipt| safe_reason(receipt.reason.as_deref(), &receipt.status)),
            last_duration_ms: terminal.and_then(|receipt| {
                receipt
                    .completed_at_ms
                    .map(|at| at.saturating_sub(receipt.observed_at_ms))
            }),
        },
    })
}

fn safe_reason(reason: Option<&str>, status: &str) -> String {
    match reason {
        Some("server_was_offline") => "The scheduler was offline; this occurrence was not sent",
        Some("restart_during_submission") => {
            "The server restarted during submission; do not automatically retry"
        }
        Some("run_not_found") => "The submitted run could not be found",
        _ => match status {
            "outcomeUnknown" => "The scheduled run outcome is unknown",
            "cancelled" => "The scheduled run was cancelled",
            "missed" => "The scheduled occurrence was missed",
            _ => "The scheduled run failed or was rejected",
        },
    }
    .into()
}

pub(super) fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, ()> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

fn optional_text(value: &Value, field: &str) -> Result<Option<String>, ()> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(()),
    }
}

fn optional_u64(value: &Value, field: &str) -> Result<Option<u64>, ()> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or(()),
    }
}
