use serde_json::{Map, Value};

#[derive(Clone)]
pub(crate) struct JobResponse {
    id: String,
    name: String,
    agent_id: String,
    message: String,
    model: Option<String>,
    schedule: ScheduleResponse,
    delivery: DeliveryResponse,
    target: Option<TargetResponse>,
    enabled: bool,
    created_at: String,
    updated_at: String,
    last_run: Option<LastRunResponse>,
    next_run: Option<String>,
    running_at: Option<String>,
}

#[derive(Clone)]
enum ScheduleResponse {
    At {
        at: String,
    },
    Every {
        every_ms: u64,
        anchor_ms: Option<u64>,
    },
    Cron {
        expr: String,
        tz: Option<String>,
    },
}

#[derive(Clone)]
enum DeliveryResponse {
    None,
    Announce {
        channel: String,
        to: Option<String>,
        account_id: Option<String>,
    },
}

#[derive(Clone)]
struct TargetResponse {
    channel_type: String,
    channel_id: String,
    channel_name: String,
    recipient: Option<String>,
}

#[derive(Clone)]
struct LastRunResponse {
    time: String,
    success: bool,
    error: Option<String>,
    duration: Option<u64>,
}

impl TryFrom<crate::model::CronJobView> for JobResponse {
    type Error = &'static str;

    fn try_from(job: crate::model::CronJobView) -> Result<Self, Self::Error> {
        let agent_id = job
            .agent_id
            .filter(|value| is_non_empty_legacy_text(value))
            .ok_or("agentId.missing")?;
        let message = job
            .message
            .filter(|value| is_non_empty_legacy_text(value))
            .ok_or("message.missing")?;
        let state = job.state;
        let last_run = state
            .last_run_at_ms
            .filter(|time| *time > 0)
            .map(|time| -> Result<LastRunResponse, &'static str> {
                Ok(LastRunResponse {
                    time: iso_timestamp(time).map_err(|_| "lastRun.time.invalid")?,
                    success: matches!(
                        state.last_run_status,
                        Some(crate::model::CronRunStatusView::Ok)
                    ),
                    error: state.last_error.clone(),
                    duration: state.last_duration_ms,
                })
            })
            .transpose()?;
        let next_run = state
            .next_run_at_ms
            .filter(|time| *time > 0)
            .map(|time| iso_timestamp(time).map_err(|_| "nextRun.invalid"))
            .transpose()?;
        let running_at = state
            .running_at_ms
            .filter(|time| *time > 0)
            .map(|time| iso_timestamp(time).map_err(|_| "runningAt.invalid"))
            .transpose()?;
        let (delivery, target) = match job.delivery {
            crate::model::CronDeliveryView::None => (DeliveryResponse::None, None),
            crate::model::CronDeliveryView::Announce {
                channel,
                to,
                account_id,
            } => {
                let target = TargetResponse {
                    channel_type: channel.clone(),
                    channel_id: account_id.clone(),
                    channel_name: channel.clone(),
                    recipient: Some(to.clone()),
                };
                (
                    DeliveryResponse::Announce {
                        channel,
                        to: Some(to),
                        account_id: Some(account_id),
                    },
                    Some(target),
                )
            }
        };
        Ok(Self {
            id: job.id,
            name: job.name,
            agent_id,
            message,
            model: job.model,
            schedule: match job.schedule {
                crate::model::CronScheduleView::At { at } => ScheduleResponse::At { at },
                crate::model::CronScheduleView::Every {
                    every_ms,
                    anchor_ms,
                } => ScheduleResponse::Every {
                    every_ms,
                    anchor_ms,
                },
                crate::model::CronScheduleView::Cron { expr, tz } => {
                    ScheduleResponse::Cron { expr, tz }
                }
            },
            delivery,
            target,
            enabled: job.enabled,
            created_at: iso_timestamp(job.created_at_ms).map_err(|_| "createdAt.invalid")?,
            updated_at: iso_timestamp(job.updated_at_ms).map_err(|_| "updatedAt.invalid")?,
            last_run,
            next_run,
            running_at,
        })
    }
}

pub(crate) fn project_job_response(job: JobResponse) -> Value {
    let mut value = Map::new();
    value.insert("id".to_owned(), Value::String(job.id));
    value.insert("name".to_owned(), Value::String(job.name));
    value.insert("agentId".to_owned(), Value::String(job.agent_id));
    value.insert("message".to_owned(), Value::String(job.message));
    if let Some(model) = job.model {
        value.insert("model".to_owned(), Value::String(model));
    }
    value.insert(
        "schedule".to_owned(),
        project_schedule_response(job.schedule),
    );
    value.insert(
        "delivery".to_owned(),
        project_delivery_response(job.delivery),
    );
    if let Some(target) = job.target {
        value.insert("target".to_owned(), project_target_response(target));
    }
    value.insert("enabled".to_owned(), Value::Bool(job.enabled));
    value.insert("createdAt".to_owned(), Value::String(job.created_at));
    value.insert("updatedAt".to_owned(), Value::String(job.updated_at));
    if let Some(last_run) = job.last_run {
        value.insert("lastRun".to_owned(), project_last_run_response(last_run));
    }
    if let Some(next_run) = job.next_run {
        value.insert("nextRun".to_owned(), Value::String(next_run));
    }
    if let Some(running_at) = job.running_at {
        value.insert("runningAt".to_owned(), Value::String(running_at));
    }
    Value::Object(value)
}

fn project_schedule_response(schedule: ScheduleResponse) -> Value {
    match schedule {
        ScheduleResponse::At { at } => serde_json::json!({ "kind": "at", "at": at }),
        ScheduleResponse::Every {
            every_ms,
            anchor_ms,
        } => {
            let mut value = Map::new();
            value.insert("kind".to_owned(), Value::String("every".to_owned()));
            value.insert("everyMs".to_owned(), Value::from(every_ms));
            if let Some(anchor_ms) = anchor_ms {
                value.insert("anchorMs".to_owned(), Value::from(anchor_ms));
            }
            Value::Object(value)
        }
        ScheduleResponse::Cron { expr, tz } => {
            let mut value = Map::new();
            value.insert("kind".to_owned(), Value::String("cron".to_owned()));
            value.insert("expr".to_owned(), Value::String(expr));
            if let Some(tz) = tz {
                value.insert("tz".to_owned(), Value::String(tz));
            }
            Value::Object(value)
        }
    }
}

fn project_delivery_response(delivery: DeliveryResponse) -> Value {
    match delivery {
        DeliveryResponse::None => serde_json::json!({ "mode": "none" }),
        DeliveryResponse::Announce {
            channel,
            to,
            account_id,
        } => {
            let mut value = Map::new();
            value.insert("mode".to_owned(), Value::String("announce".to_owned()));
            value.insert("channel".to_owned(), Value::String(channel));
            if let Some(to) = to {
                value.insert("to".to_owned(), Value::String(to));
            }
            if let Some(account_id) = account_id {
                value.insert("accountId".to_owned(), Value::String(account_id));
            }
            Value::Object(value)
        }
    }
}

fn project_target_response(target: TargetResponse) -> Value {
    let mut value = Map::new();
    value.insert("channelType".to_owned(), Value::String(target.channel_type));
    value.insert("channelId".to_owned(), Value::String(target.channel_id));
    value.insert("channelName".to_owned(), Value::String(target.channel_name));
    if let Some(recipient) = target.recipient {
        value.insert("recipient".to_owned(), Value::String(recipient));
    }
    Value::Object(value)
}

fn project_last_run_response(last_run: LastRunResponse) -> Value {
    let mut value = Map::new();
    value.insert("time".to_owned(), Value::String(last_run.time));
    value.insert("success".to_owned(), Value::Bool(last_run.success));
    if let Some(error) = last_run.error {
        value.insert("error".to_owned(), Value::String(error));
    }
    if let Some(duration) = last_run.duration {
        value.insert("duration".to_owned(), Value::from(duration));
    }
    Value::Object(value)
}

fn iso_timestamp(milliseconds: u64) -> Result<String, ()> {
    let milliseconds = i64::try_from(milliseconds).map_err(|_| ())?;
    chrono::DateTime::from_timestamp_millis(milliseconds)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or(())
}

fn is_non_empty_legacy_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains(' ')
}
