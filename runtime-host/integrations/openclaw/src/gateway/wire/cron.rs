use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    GatewayEvent, GatewayResponse, RpcRequest, WireError, rpc_request, success_payload,
    valid_optional_string, valid_string,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) const CRON_LIST_METHOD: &str = "cron.list";
pub(crate) const CRON_ADD_METHOD: &str = "cron.add";
pub(crate) const CRON_UPDATE_METHOD: &str = "cron.update";
pub(crate) const CRON_REMOVE_METHOD: &str = "cron.remove";
pub(crate) const CRON_RUN_METHOD: &str = "cron.run";
pub(crate) const CRON_RUNS_METHOD: &str = "cron.runs";

const CRON_LIST_PAGE_LIMIT: u64 = 200;
const MAX_CRON_RUNS_PAGE_LIMIT: u64 = 200;

pub fn list_request(request_id: String, offset: u64) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !valid_safe_integer(offset) {
        return Err(WireError::InvalidCronListRequest);
    }
    rpc_request(
        request_id,
        CRON_LIST_METHOD,
        Some(serde_json::json!({
            "includeDisabled": true,
            "includeDeliveryPreviews": false,
            "limit": CRON_LIST_PAGE_LIMIT,
            "offset": offset,
        })),
    )
    .map_err(|_| WireError::InvalidCronListRequest)
}

pub fn add_request(request_id: String, job: CronJobCreate) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !job.is_valid() {
        return Err(WireError::InvalidCronAddRequest);
    }
    let params = serde_json::to_value(job).map_err(|_| WireError::InvalidCronAddRequest)?;
    rpc_request(request_id, CRON_ADD_METHOD, Some(params))
        .map_err(|_| WireError::InvalidCronAddRequest)
}

pub fn update_request(
    request_id: String,
    job_id: String,
    patch: CronJobPatch,
    expected_config_revision: Option<String>,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id)
        || !valid_string(&job_id)
        || !valid_optional_string(&expected_config_revision)
        || !patch.is_valid()
    {
        return Err(WireError::InvalidCronUpdateRequest);
    }
    let params = serde_json::to_value(CronUpdateParams {
        id: job_id,
        patch,
        expected_config_revision,
    })
    .map_err(|_| WireError::InvalidCronUpdateRequest)?;
    rpc_request(request_id, CRON_UPDATE_METHOD, Some(params))
        .map_err(|_| WireError::InvalidCronUpdateRequest)
}

pub fn remove_request(request_id: String, job_id: String) -> Result<RpcRequest, WireError> {
    id_request(
        request_id,
        CRON_REMOVE_METHOD,
        job_id,
        WireError::InvalidCronRemoveRequest,
    )
}

pub fn run_force_request(request_id: String, job_id: String) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !valid_string(&job_id) {
        return Err(WireError::InvalidCronRunRequest);
    }
    let params = serde_json::to_value(CronRunParams {
        id: job_id,
        mode: CronRunMode::Force,
    })
    .map_err(|_| WireError::InvalidCronRunRequest)?;
    rpc_request(request_id, CRON_RUN_METHOD, Some(params))
        .map_err(|_| WireError::InvalidCronRunRequest)
}

pub(crate) fn decode_run_finished_event(
    event: GatewayEvent,
    job_id: &str,
    run_id: &str,
) -> Result<Option<CronRunStatus>, WireError> {
    if event.name != "cron" {
        return Ok(None);
    }
    let payload: CronEventWire =
        serde_json::from_value(event.payload.ok_or(WireError::InvalidEvent)?)
            .map_err(|_| WireError::InvalidEvent)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidEvent);
    }
    if payload.action != "finished"
        || payload.job_id != job_id
        || payload.run_id.as_deref() != Some(run_id)
    {
        return Ok(None);
    }
    Ok(payload.status.map(CronRunStatusWire::into_public))
}

pub fn runs_request(request_id: String, job_id: String) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !valid_job_log_id(&job_id) {
        return Err(WireError::InvalidCronRunsRequest);
    }
    let params = serde_json::to_value(CronRunsParams {
        scope: "job",
        id: job_id,
        limit: MAX_CRON_RUNS_PAGE_LIMIT,
        offset: 0,
        sort_dir: "desc",
    })
    .map_err(|_| WireError::InvalidCronRunsRequest)?;
    rpc_request(request_id, CRON_RUNS_METHOD, Some(params))
        .map_err(|_| WireError::InvalidCronRunsRequest)
}

pub fn runs_page_request(
    request_id: String,
    job_id: String,
    limit: u64,
    offset: u64,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id)
        || !valid_job_log_id(&job_id)
        || !(1..=MAX_CRON_RUNS_PAGE_LIMIT).contains(&limit)
        || !valid_safe_integer(offset)
    {
        return Err(WireError::InvalidCronRunsRequest);
    }
    let params = serde_json::to_value(CronRunsPageParams {
        scope: "job",
        id: job_id,
        run_id: None,
        limit,
        offset,
        sort_dir: "desc",
    })
    .map_err(|_| WireError::InvalidCronRunsRequest)?;
    rpc_request(request_id, CRON_RUNS_METHOD, Some(params))
        .map_err(|_| WireError::InvalidCronRunsRequest)
}

fn id_request(
    request_id: String,
    method: &'static str,
    job_id: String,
    error: WireError,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !valid_string(&job_id) {
        return Err(error);
    }
    let params = serde_json::to_value(CronIdParams { id: job_id }).map_err(|_| error)?;
    rpc_request(request_id, method, Some(params)).map_err(|_| error)
}

pub struct CronJobCreate {
    name: String,
    schedule: CronSchedule,
    session_target: CronSessionTarget,
    wake_mode: CronWakeMode,
    payload: CronPayload,
    delivery: CronDelivery,
    agent_id: Option<String>,
    enabled: Option<bool>,
}

impl CronJobCreate {
    pub fn system_event(
        name: impl Into<String>,
        schedule: CronSchedule,
        wake_mode: CronWakeMode,
        text: impl Into<String>,
    ) -> Result<Self, WireError> {
        Self::new(
            name,
            schedule,
            CronSessionTarget::Main,
            wake_mode,
            CronPayload::system_event(text)?,
        )
    }

    pub fn isolated_agent_turn(
        name: impl Into<String>,
        schedule: CronSchedule,
        wake_mode: CronWakeMode,
        message: impl Into<String>,
    ) -> Result<Self, WireError> {
        Self::new(
            name,
            schedule,
            CronSessionTarget::Isolated,
            wake_mode,
            CronPayload::agent_turn(message)?,
        )
    }

    fn new(
        name: impl Into<String>,
        schedule: CronSchedule,
        session_target: CronSessionTarget,
        wake_mode: CronWakeMode,
        payload: CronPayload,
    ) -> Result<Self, WireError> {
        let name = name.into();
        if !valid_string(&name)
            || !matches!(
                (&session_target, &payload),
                (CronSessionTarget::Main, CronPayload::SystemEvent { .. })
                    | (CronSessionTarget::Isolated, CronPayload::AgentTurn { .. })
            )
        {
            return Err(WireError::InvalidCronAddRequest);
        }
        Ok(Self {
            name,
            schedule,
            session_target,
            wake_mode,
            payload,
            delivery: CronDelivery::None,
            agent_id: None,
            enabled: None,
        })
    }

    pub fn with_agent_id(mut self, agent_id: String) -> Result<Self, WireError> {
        if !valid_string(&agent_id) {
            return Err(WireError::InvalidCronAddRequest);
        }
        self.agent_id = Some(agent_id);
        Ok(self)
    }

    pub fn with_model(mut self, model: Option<String>) -> Result<Self, WireError> {
        if !valid_optional_string(&model) {
            return Err(WireError::InvalidCronAddRequest);
        }
        let CronPayload::AgentTurn { model: current, .. } = &mut self.payload else {
            return Err(WireError::InvalidCronAddRequest);
        };
        *current = model;
        Ok(self)
    }

    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = Some(enabled);
        self
    }

    pub fn with_announcement_delivery(
        mut self,
        channel: String,
        to: String,
        account_id: String,
    ) -> Result<Self, WireError> {
        self.delivery = CronDelivery::announce(channel, to, account_id)?;
        Ok(self)
    }

    pub fn with_no_delivery(mut self) -> Self {
        self.delivery = CronDelivery::None;
        self
    }

    pub fn with_webhook_delivery(mut self, to: String) -> Result<Self, WireError> {
        self.delivery = CronDelivery::webhook(to)?;
        Ok(self)
    }

    fn is_valid(&self) -> bool {
        valid_string(&self.name)
            && self.schedule.is_valid()
            && self.session_target.is_valid()
            && self.payload.is_valid()
            && self.delivery.is_valid()
            && self
                .agent_id
                .as_ref()
                .is_none_or(|value| valid_string(value))
            && matches!(
                (&self.session_target, &self.payload),
                (CronSessionTarget::Main, CronPayload::SystemEvent { .. })
                    | (CronSessionTarget::Isolated, CronPayload::AgentTurn { .. })
            )
    }
}

impl fmt::Debug for CronJobCreate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CronJobCreate([REDACTED])")
    }
}

impl Serialize for CronJobCreate {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params<'a> {
            name: &'a str,
            schedule: &'a CronSchedule,
            session_target: &'a CronSessionTarget,
            wake_mode: &'a CronWakeMode,
            payload: &'a CronPayload,
            delivery: &'a CronDelivery,
            #[serde(skip_serializing_if = "Option::is_none")]
            agent_id: &'a Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            enabled: &'a Option<bool>,
        }

        Params {
            name: &self.name,
            schedule: &self.schedule,
            session_target: &self.session_target,
            wake_mode: &self.wake_mode,
            payload: &self.payload,
            delivery: &self.delivery,
            agent_id: &self.agent_id,
            enabled: &self.enabled,
        }
        .serialize(serializer)
    }
}

pub enum CronSchedule {
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
        stagger_ms: Option<u64>,
    },
}

impl CronSchedule {
    pub fn at(at: String) -> Result<Self, WireError> {
        valid_string(&at)
            .then_some(Self::At { at })
            .ok_or(WireError::InvalidCronAddRequest)
    }

    pub fn every(every_ms: u64) -> Result<Self, WireError> {
        Self::every_with_anchor(every_ms, None)
    }

    pub fn every_with_anchor(every_ms: u64, anchor_ms: Option<u64>) -> Result<Self, WireError> {
        (every_ms > 0 && valid_safe_integer(every_ms) && valid_optional_safe_integer(anchor_ms))
            .then_some(Self::Every {
                every_ms,
                anchor_ms,
            })
            .ok_or(WireError::InvalidCronAddRequest)
    }

    pub fn cron(expr: String) -> Result<Self, WireError> {
        Self::cron_with_options(expr, None, None)
    }

    pub fn cron_with_options(
        expr: String,
        tz: Option<String>,
        stagger_ms: Option<u64>,
    ) -> Result<Self, WireError> {
        (valid_string(&expr)
            && valid_optional_string(&tz)
            && valid_optional_safe_integer(stagger_ms))
        .then_some(Self::Cron {
            expr,
            tz,
            stagger_ms,
        })
        .ok_or(WireError::InvalidCronAddRequest)
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::At { at } => valid_string(at),
            Self::Every {
                every_ms,
                anchor_ms,
            } => {
                *every_ms > 0
                    && valid_safe_integer(*every_ms)
                    && valid_optional_safe_integer(*anchor_ms)
            }
            Self::Cron {
                expr,
                tz,
                stagger_ms,
            } => {
                valid_string(expr)
                    && valid_optional_string(tz)
                    && valid_optional_safe_integer(*stagger_ms)
            }
        }
    }
}

impl Serialize for CronSchedule {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::At { at } => {
                #[derive(Serialize)]
                struct At<'a> {
                    kind: &'static str,
                    at: &'a str,
                }
                At { kind: "at", at }.serialize(serializer)
            }
            Self::Every {
                every_ms,
                anchor_ms,
            } => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Every {
                    kind: &'static str,
                    every_ms: u64,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    anchor_ms: Option<u64>,
                }
                Every {
                    kind: "every",
                    every_ms: *every_ms,
                    anchor_ms: *anchor_ms,
                }
                .serialize(serializer)
            }
            Self::Cron {
                expr,
                tz,
                stagger_ms,
            } => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Cron<'a> {
                    kind: &'static str,
                    expr: &'a str,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    tz: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    stagger_ms: &'a Option<u64>,
                }
                Cron {
                    kind: "cron",
                    expr,
                    tz,
                    stagger_ms,
                }
                .serialize(serializer)
            }
        }
    }
}

pub enum CronSessionTarget {
    Main,
    Isolated,
}

impl CronSessionTarget {
    fn is_valid(&self) -> bool {
        true
    }
}

impl Serialize for CronSessionTarget {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            Self::Main => "main",
            Self::Isolated => "isolated",
        })
    }
}

pub enum CronWakeMode {
    Now,
    NextHeartbeat,
}

impl Serialize for CronWakeMode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            Self::Now => "now",
            Self::NextHeartbeat => "next-heartbeat",
        })
    }
}

pub(crate) enum CronPayload {
    SystemEvent {
        text: String,
    },
    AgentTurn {
        message: String,
        model: Option<String>,
    },
}

impl CronPayload {
    fn system_event(text: impl Into<String>) -> Result<Self, WireError> {
        let text = text.into();
        valid_string(&text)
            .then_some(Self::SystemEvent { text })
            .ok_or(WireError::InvalidCronAddRequest)
    }

    fn agent_turn(message: impl Into<String>) -> Result<Self, WireError> {
        let message = message.into();
        valid_string(&message)
            .then_some(Self::AgentTurn {
                message,
                model: None,
            })
            .ok_or(WireError::InvalidCronAddRequest)
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::SystemEvent { text } => valid_string(text),
            Self::AgentTurn { message, model } => {
                valid_string(message) && valid_optional_string(model)
            }
        }
    }
}

impl Serialize for CronPayload {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::SystemEvent { text } => {
                #[derive(Serialize)]
                struct SystemEvent<'a> {
                    kind: &'static str,
                    text: &'a str,
                }
                SystemEvent {
                    kind: "systemEvent",
                    text,
                }
                .serialize(serializer)
            }
            Self::AgentTurn { message, model } => {
                #[derive(Serialize)]
                struct AgentTurn<'a> {
                    kind: &'static str,
                    message: &'a str,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    model: &'a Option<String>,
                }
                AgentTurn {
                    kind: "agentTurn",
                    message,
                    model,
                }
                .serialize(serializer)
            }
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum CronDelivery {
    None,
    Announce {
        channel: String,
        to: String,
        account_id: String,
    },
    Webhook {
        to: String,
    },
}

impl CronDelivery {
    fn announce(channel: String, to: String, account_id: String) -> Result<Self, WireError> {
        (valid_string(&channel) && valid_string(&to) && valid_string(&account_id))
            .then_some(Self::Announce {
                channel,
                to,
                account_id,
            })
            .ok_or(WireError::InvalidCronAddRequest)
    }

    fn webhook(to: String) -> Result<Self, WireError> {
        valid_string(&to)
            .then_some(Self::Webhook { to })
            .ok_or(WireError::InvalidCronAddRequest)
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::None => true,
            Self::Announce {
                channel,
                to,
                account_id,
            } => valid_string(channel) && valid_string(to) && valid_string(account_id),
            Self::Webhook { to } => valid_string(to),
        }
    }
}

impl Serialize for CronDelivery {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        struct NoneDelivery {
            mode: &'static str,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct AnnounceDelivery<'a> {
            mode: &'static str,
            channel: &'a str,
            to: &'a str,
            account_id: &'a str,
        }
        match self {
            Self::None => NoneDelivery { mode: "none" }.serialize(serializer),
            Self::Announce {
                channel,
                to,
                account_id,
            } => AnnounceDelivery {
                mode: "announce",
                channel,
                to,
                account_id,
            }
            .serialize(serializer),
            Self::Webhook { to } => {
                #[derive(Serialize)]
                struct WebhookDelivery<'a> {
                    mode: &'static str,
                    to: &'a str,
                }
                WebhookDelivery {
                    mode: "webhook",
                    to,
                }
                .serialize(serializer)
            }
        }
    }
}

pub enum CronJobPatch {
    Update(CronJobUpdate),
}

pub struct CronJobUpdate {
    name: Option<String>,
    agent_id: Option<String>,
    message: Option<String>,
    model: Option<Option<String>>,
    schedule: Option<CronSchedule>,
    delivery: Option<CronDelivery>,
    enabled: Option<bool>,
}

impl CronJobUpdate {
    pub fn new(
        name: Option<String>,
        agent_id: Option<String>,
        message: Option<String>,
        model: Option<Option<String>>,
        schedule: Option<CronSchedule>,
        enabled: Option<bool>,
    ) -> Result<Self, WireError> {
        Self::build(name, agent_id, message, model, schedule, None, enabled)
    }

    pub fn with_no_delivery(mut self) -> Result<Self, WireError> {
        self.delivery = Some(CronDelivery::None);
        self.validate()?;
        Ok(self)
    }

    pub fn with_announcement_delivery(
        mut self,
        channel: String,
        to: String,
        account_id: String,
    ) -> Result<Self, WireError> {
        self.delivery = Some(CronDelivery::announce(channel, to, account_id)?);
        self.validate()?;
        Ok(self)
    }

    pub fn with_webhook_delivery(mut self, to: String) -> Result<Self, WireError> {
        self.delivery = Some(CronDelivery::webhook(to)?);
        self.validate()?;
        Ok(self)
    }

    fn build(
        name: Option<String>,
        agent_id: Option<String>,
        message: Option<String>,
        model: Option<Option<String>>,
        schedule: Option<CronSchedule>,
        delivery: Option<CronDelivery>,
        enabled: Option<bool>,
    ) -> Result<Self, WireError> {
        let update = Self {
            name,
            agent_id,
            message,
            model,
            schedule,
            delivery,
            enabled,
        };
        update.validate()?;
        Ok(update)
    }

    fn validate(&self) -> Result<(), WireError> {
        if self.name.as_ref().is_some_and(|value| !valid_string(value))
            || self
                .agent_id
                .as_ref()
                .is_some_and(|value| !valid_string(value))
            || self
                .message
                .as_ref()
                .is_some_and(|value| !valid_string(value))
            || self
                .model
                .as_ref()
                .is_some_and(|value| !valid_optional_string(value))
            || self
                .schedule
                .as_ref()
                .is_some_and(|value| !value.is_valid())
            || self
                .delivery
                .as_ref()
                .is_some_and(|value| !value.is_valid())
            || (self.name.is_none()
                && self.agent_id.is_none()
                && self.message.is_none()
                && self.model.is_none()
                && self.schedule.is_none()
                && self.delivery.is_none()
                && self.enabled.is_none())
        {
            return Err(WireError::InvalidCronUpdateRequest);
        }
        Ok(())
    }
}

impl CronJobPatch {
    pub fn update(update: CronJobUpdate) -> Self {
        Self::Update(update)
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::Update(update) => {
                update.name.as_ref().is_none_or(|value| valid_string(value))
                    && update
                        .agent_id
                        .as_ref()
                        .is_none_or(|value| valid_string(value))
                    && update
                        .message
                        .as_ref()
                        .is_none_or(|value| valid_string(value))
                    && update.model.as_ref().is_none_or(valid_optional_string)
                    && update.schedule.as_ref().is_none_or(CronSchedule::is_valid)
                    && update.delivery.as_ref().is_none_or(CronDelivery::is_valid)
                    && (update.name.is_some()
                        || update.agent_id.is_some()
                        || update.message.is_some()
                        || update.model.is_some()
                        || update.schedule.is_some()
                        || update.delivery.is_some()
                        || update.enabled.is_some())
            }
        }
    }
}

impl fmt::Debug for CronJobPatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CronJobPatch([REDACTED])")
    }
}

impl Serialize for CronJobPatch {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Update(update) => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Update<'a> {
                    #[serde(skip_serializing_if = "Option::is_none")]
                    name: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    agent_id: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    payload: Option<UpdatePayload<'a>>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    schedule: &'a Option<CronSchedule>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    delivery: &'a Option<CronDelivery>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    enabled: &'a Option<bool>,
                }
                #[derive(Serialize)]
                struct UpdatePayload<'a> {
                    kind: &'static str,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    message: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    model: &'a Option<Option<String>>,
                }
                Update {
                    name: &update.name,
                    agent_id: &update.agent_id,
                    payload: (update.message.is_some() || update.model.is_some()).then_some(
                        UpdatePayload {
                            kind: "agentTurn",
                            message: &update.message,
                            model: &update.model,
                        },
                    ),
                    schedule: &update.schedule,
                    delivery: &update.delivery,
                    enabled: &update.enabled,
                }
                .serialize(serializer)
            }
        }
    }
}

#[derive(Serialize)]
struct CronIdParams {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CronUpdateParams {
    id: String,
    patch: CronJobPatch,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_config_revision: Option<String>,
}

#[derive(Serialize)]
struct CronRunParams {
    id: String,
    mode: CronRunMode,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum CronRunMode {
    Force,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CronRunsParams {
    scope: &'static str,
    id: String,
    limit: u64,
    offset: u64,
    sort_dir: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CronRunsPageParams {
    scope: &'static str,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    limit: u64,
    offset: u64,
    sort_dir: &'static str,
}

pub struct CronJob {
    pub id: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub message: Option<String>,
    pub model: Option<String>,
    pub schedule: CronScheduleView,
    pub delivery: CronDeliveryView,
    pub enabled: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub(crate) session_target: CronSessionTargetWire,
    pub(crate) payload_kind: CronPayloadKind,
    pub(crate) state: CronJobState,
}

impl CronJob {
    pub const fn state(&self) -> &CronJobState {
        &self.state
    }
}

impl fmt::Debug for CronJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CronJob")
            .field("id", &"[REDACTED]")
            .field("name", &"[REDACTED]")
            .field("agent_id", &self.agent_id.as_ref().map(|_| "[REDACTED]"))
            .field("message", &self.message.as_ref().map(|_| "[REDACTED]"))
            .field("model", &self.model.as_ref().map(|_| "[REDACTED]"))
            .field("schedule", &self.schedule)
            .field("delivery", &self.delivery)
            .field("enabled", &self.enabled)
            .field("created_at_ms", &self.created_at_ms)
            .field("updated_at_ms", &self.updated_at_ms)
            .field("session_target", &self.session_target)
            .field("payload_kind", &self.payload_kind)
            .field("state", &self.state)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CronScheduleView {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CronDeliveryView {
    None,
    Announce {
        channel: String,
        to: String,
        account_id: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronSessionTargetWire {
    Main,
    Isolated,
    Current,
    Named,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronPayloadKind {
    SystemEvent,
    AgentTurn,
}

#[derive(Clone, Eq, PartialEq)]
pub struct CronJobState {
    pub next_run_at_ms: Option<u64>,
    pub running_at_ms: Option<u64>,
    pub last_run_at_ms: Option<u64>,
    pub last_run_status: Option<CronRunStatus>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

impl fmt::Debug for CronJobState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CronJobState")
            .field("next_run_at_ms", &self.next_run_at_ms)
            .field("running_at_ms", &self.running_at_ms)
            .field("last_run_at_ms", &self.last_run_at_ms)
            .field("last_run_status", &self.last_run_status)
            .field(
                "last_error",
                &self.last_error.as_ref().map(|_| "[REDACTED]"),
            )
            .field("last_duration_ms", &self.last_duration_ms)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronRunStatus {
    Ok,
    Error,
    Skipped,
}

#[derive(Debug)]
pub struct CronJobs {
    pub jobs: Vec<CronJob>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
    pub has_more: bool,
    pub(crate) next_offset: Option<u64>,
}

pub struct CronRunReceipt {
    outcome: CronRunReceiptOutcome,
}

impl CronRunReceipt {
    pub(crate) fn into_outcome(self) -> CronRunReceiptOutcome {
        self.outcome
    }
}

impl fmt::Debug for CronRunReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("CronRunReceipt");
        match &self.outcome {
            CronRunReceiptOutcome::Enqueued { .. } => debug
                .field("outcome", &"enqueued")
                .field("run_id", &Some("[REDACTED]")),
            CronRunReceiptOutcome::Ran => debug.field("outcome", &"ran"),
            CronRunReceiptOutcome::Skipped(disposition) => debug
                .field("outcome", &"skipped")
                .field("disposition", disposition),
            CronRunReceiptOutcome::OutcomeUnknown => debug.field("outcome", &"outcome-unknown"),
        }
        .finish()
    }
}

pub(crate) enum CronRunReceiptOutcome {
    Enqueued { run_id: String },
    Ran,
    Skipped(CronRunDisposition),
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CronRunDisposition {
    AlreadyRunning,
    NotDue,
    InvalidSpec,
    Disabled,
    Stopped,
}

pub struct CronRunLog {
    pub entries: Vec<CronRunLogEntry>,
}

pub struct CronRunLogEntry {
    pub job_id: String,
    pub run_id: Option<String>,
    pub(crate) status: Option<CronRunStatus>,
}

impl CronRunLogEntry {
    pub fn status(&self) -> Option<CronRunStatus> {
        self.status
    }
}

impl fmt::Debug for CronRunLogEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CronRunLogEntry")
            .field("job_id", &"[REDACTED]")
            .field("run_id", &self.run_id.as_ref().map(|_| "[REDACTED]"))
            .field("status", &self.status)
            .finish()
    }
}

#[derive(Debug)]
pub struct CronRunHistoryPage {
    pub entries: Vec<CronRunHistoryEntry>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
    pub has_more: bool,
    pub next_offset: Option<u64>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct CronRunHistoryEntry {
    pub job_id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub session_key: Option<String>,
    pub timestamp_ms: u64,
    pub(crate) status: Option<CronRunStatus>,
}

impl CronRunHistoryEntry {
    pub fn status(&self) -> Option<CronRunStatus> {
        self.status
    }
}

impl fmt::Debug for CronRunHistoryEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CronRunHistoryEntry")
            .field("job_id", &"[REDACTED]")
            .field("run_id", &self.run_id.as_ref().map(|_| "[REDACTED]"))
            .field(
                "session_id",
                &self.session_id.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "session_key",
                &self.session_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("timestamp_ms", &self.timestamp_ms)
            .field("status", &self.status)
            .finish()
    }
}

#[derive(Debug)]
pub struct CronRemoved {
    pub removed: bool,
}

pub fn decode_list(response: GatewayResponse) -> Result<CronJobs, WireError> {
    let payload = success_payload(response, WireError::InvalidCronList)?;
    let payload: CronListWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidCronList)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidCronList);
    }
    let CronListWire {
        jobs,
        total,
        offset,
        limit,
        has_more,
        next_offset,
        delivery_previews: _,
        snapshot_revision: _,
        config_revision: _,
    } = payload;
    Ok(CronJobs {
        jobs: jobs
            .into_iter()
            .filter(CronJobWire::is_ui_crud_projection)
            .map(CronJobWire::into_public)
            .collect(),
        total,
        offset,
        limit,
        has_more,
        next_offset,
    })
}

pub fn decode_add(response: GatewayResponse) -> Result<CronJob, WireError> {
    let payload = success_payload(response, WireError::InvalidCronAdd)?;
    let payload = decode_job_mutation_payload(payload, WireError::InvalidCronAdd)?;
    (payload.is_valid() && payload.is_ui_crud_projection())
        .then(|| payload.into_public())
        .ok_or(WireError::InvalidCronAdd)
}

pub fn decode_update(response: GatewayResponse) -> Result<CronJob, WireError> {
    let payload = success_payload(response, WireError::InvalidCronUpdate)?;
    let payload = decode_job_mutation_payload(payload, WireError::InvalidCronUpdate)?;
    (payload.is_valid() && payload.is_ui_crud_projection())
        .then(|| payload.into_public())
        .ok_or(WireError::InvalidCronUpdate)
}

fn decode_job_mutation_payload(payload: Value, error: WireError) -> Result<CronJobWire, WireError> {
    if payload.get("job").is_some() {
        let wrapper: CronJobMutationWrapperWire =
            serde_json::from_value(payload).map_err(|_| error)?;
        return wrapper.into_job().ok_or(error);
    }
    serde_json::from_value(payload).map_err(|_| error)
}

pub fn decode_remove(response: GatewayResponse) -> Result<CronRemoved, WireError> {
    let payload = success_payload(response, WireError::InvalidCronRemove)?;
    let payload: CronRemoveWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidCronRemove)?;
    Ok(CronRemoved {
        removed: payload.ok && payload.removed,
    })
}

pub fn decode_run(response: GatewayResponse) -> Result<CronRunReceipt, WireError> {
    let payload = success_payload(response, WireError::InvalidCronRun)?;
    let payload: CronRunWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidCronRun)?;
    payload.into_public().ok_or(WireError::InvalidCronRun)
}

pub fn decode_runs(response: GatewayResponse) -> Result<CronRunLog, WireError> {
    let page = decode_runs_page(response)?;
    Ok(CronRunLog {
        entries: page
            .entries
            .into_iter()
            .map(|entry| CronRunLogEntry {
                job_id: entry.job_id,
                run_id: entry.run_id,
                status: entry.status,
            })
            .collect(),
    })
}

pub fn decode_runs_page(response: GatewayResponse) -> Result<CronRunHistoryPage, WireError> {
    let payload = success_payload(response, WireError::InvalidCronRuns)?;
    let payload: CronRunsWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidCronRuns)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidCronRuns);
    }
    Ok(CronRunHistoryPage {
        entries: payload
            .entries
            .into_iter()
            .map(CronRunLogEntryWire::into_history)
            .collect(),
        total: payload.total,
        offset: payload.offset,
        limit: payload.limit,
        has_more: payload.has_more,
        next_offset: payload.next_offset,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronListWire {
    jobs: Vec<CronJobWire>,
    total: u64,
    offset: u64,
    limit: u64,
    has_more: bool,
    next_offset: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_object")]
    delivery_previews: Option<Value>,
    #[serde(default)]
    snapshot_revision: Option<String>,
    #[serde(default)]
    config_revision: Option<String>,
}

impl CronListWire {
    fn is_valid(&self) -> bool {
        let Some(expected_next_offset) = self.offset.checked_add(self.jobs.len() as u64) else {
            return false;
        };
        self.limit > 0
            && expected_next_offset <= self.total
            && valid_safe_integer(self.total)
            && valid_safe_integer(self.offset)
            && valid_safe_integer(self.limit)
            && self.limit <= CRON_LIST_PAGE_LIMIT
            && valid_optional_safe_integer(self.next_offset)
            && self.offset <= self.total
            && self.jobs.len() as u64 <= self.limit
            && if self.has_more {
                self.next_offset == Some(expected_next_offset) && expected_next_offset < self.total
            } else {
                self.next_offset.is_none() && expected_next_offset == self.total
            }
            && self.delivery_previews.as_ref().is_none_or(Value::is_object)
            && valid_optional_string(&self.snapshot_revision)
            && valid_optional_string(&self.config_revision)
            && self.jobs.iter().all(CronJobWire::is_valid)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronJobMutationWrapperWire {
    job: CronJobWire,
    #[serde(default)]
    created: Option<bool>,
    #[serde(default)]
    updated: Option<bool>,
    #[serde(default)]
    delivery_preview: Option<CronDeliveryPreviewWire>,
}

impl CronJobMutationWrapperWire {
    fn into_job(self) -> Option<CronJobWire> {
        let _ = (self.created, self.updated);
        self.delivery_preview
            .as_ref()
            .is_none_or(CronDeliveryPreviewWire::is_valid)
            .then_some(self.job)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronDeliveryPreviewWire {
    label: String,
    detail: String,
}

impl CronDeliveryPreviewWire {
    fn is_valid(&self) -> bool {
        let _ = (&self.label, &self.detail);
        true
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronJobWire {
    id: String,
    #[serde(default)]
    declaration_key: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    owner: Option<CronOwnerWire>,
    #[serde(default)]
    scheduled_tool_policy: Option<CronScheduledToolPolicyWire>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    session_key: Option<String>,
    name: String,
    #[serde(default)]
    description: Option<String>,
    enabled: bool,
    #[serde(default)]
    delete_after_run: Option<bool>,
    created_at_ms: u64,
    updated_at_ms: u64,
    #[serde(default)]
    config_revision: Option<String>,
    schedule: CronScheduleWire,
    #[serde(default)]
    pacing: Option<CronPacingWire>,
    #[serde(default)]
    trigger: Option<CronTriggerWire>,
    session_target: String,
    wake_mode: CronWakeModeWire,
    payload: CronPayloadWire,
    #[serde(default)]
    delivery: Option<CronDeliveryWire>,
    #[serde(default)]
    failure_alert: CronFailureAlertWire,
    state: CronJobStateWire,
    #[serde(default)]
    next_run_at_ms: Option<u64>,
    #[serde(default)]
    last_run_at_ms: Option<u64>,
    #[serde(default)]
    last_run_status: Option<CronRunStatusWire>,
    #[serde(default)]
    last_run_error: Option<String>,
    #[serde(default)]
    last_delivered: Option<bool>,
    #[serde(default)]
    last_delivery_status: Option<String>,
    #[serde(default)]
    last_delivery_error: Option<String>,
    #[serde(default)]
    delivery_suppression_reason: Option<String>,
    #[serde(default)]
    last_failure_notification_delivered: Option<bool>,
    #[serde(default)]
    last_failure_notification_delivery_status: Option<String>,
    #[serde(default)]
    last_failure_notification_delivery_error: Option<String>,
    #[serde(default)]
    delivery_preview: Option<CronDeliveryPreviewWire>,
}

impl CronJobWire {
    fn is_valid(&self) -> bool {
        let _ = (
            &self.agent_id,
            &self.session_key,
            &self.description,
            self.enabled,
            self.delete_after_run,
            self.created_at_ms,
            self.updated_at_ms,
            &self.wake_mode,
            &self.delivery,
            &self.failure_alert,
            self.next_run_at_ms,
            self.last_run_at_ms,
            &self.last_run_status,
            &self.last_run_error,
            self.last_delivered,
            &self.last_delivery_status,
            &self.last_delivery_error,
            &self.delivery_suppression_reason,
            self.last_failure_notification_delivered,
            &self.last_failure_notification_delivery_status,
            &self.last_failure_notification_delivery_error,
            &self.delivery_preview,
        );
        valid_safe_integer(self.created_at_ms)
            && valid_safe_integer(self.updated_at_ms)
            && valid_string(&self.id)
            && valid_string(&self.name)
            && valid_optional_string(&self.declaration_key)
            && valid_optional_string(&self.display_name)
            && self.owner.as_ref().is_none_or(CronOwnerWire::is_valid)
            && self
                .scheduled_tool_policy
                .as_ref()
                .is_none_or(CronScheduledToolPolicyWire::is_valid)
            && valid_optional_string(&self.agent_id)
            && valid_optional_string(&self.session_key)
            && valid_optional_string(&self.description)
            && valid_optional_string(&self.config_revision)
            && self.schedule.is_valid()
            && self.pacing.as_ref().is_none_or(CronPacingWire::is_valid)
            && self.trigger.as_ref().is_none_or(CronTriggerWire::is_valid)
            && cron_session_target(&self.session_target).is_some()
            && self.wake_mode.is_valid()
            && self.payload.is_valid()
            && self
                .delivery
                .as_ref()
                .is_none_or(CronDeliveryWire::is_valid)
            && self.failure_alert.is_valid()
            && self.state.is_valid()
            && valid_optional_safe_integer(self.next_run_at_ms)
            && valid_optional_safe_integer(self.last_run_at_ms)
            && valid_optional_string(&self.last_run_error)
            && valid_optional_cron_delivery_status(&self.last_delivery_status)
            && valid_optional_string(&self.last_delivery_error)
            && valid_optional_string(&self.delivery_suppression_reason)
            && valid_optional_cron_delivery_status(&self.last_failure_notification_delivery_status)
            && valid_optional_string(&self.last_failure_notification_delivery_error)
            && self
                .delivery_preview
                .as_ref()
                .is_none_or(CronDeliveryPreviewWire::is_valid)
    }

    fn is_ui_crud_projection(&self) -> bool {
        matches!(
            cron_session_target(&self.session_target),
            Some(CronSessionTargetWire::Isolated)
        ) && self.agent_id.as_deref().is_some_and(valid_string)
            && self.payload.agent_turn_message().is_some_and(valid_string)
            && self.schedule.is_ui_projection()
            && self
                .delivery
                .as_ref()
                .map(CronDeliveryWire::is_ui_projection)
                .unwrap_or(true)
    }

    fn into_public(self) -> CronJob {
        let session_target = cron_session_target(&self.session_target)
            .expect("validated cron session target must project");
        let payload_kind = self.payload.kind();
        let message = self.payload.agent_turn_message().map(ToOwned::to_owned);
        let model = match self.payload {
            CronPayloadWire::AgentTurn { model, .. } => model,
            _ => None,
        };
        let delivery = self
            .delivery
            .and_then(CronDeliveryWire::into_view)
            .unwrap_or(CronDeliveryView::None);
        CronJob {
            id: self.id,
            name: self.name,
            agent_id: self.agent_id,
            message,
            model,
            schedule: self.schedule.into_view(),
            delivery,
            enabled: self.enabled,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            session_target,
            payload_kind,
            state: self.state.into_public(),
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CronScheduleWire {
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
        stagger_ms: Option<u64>,
    },
    #[serde(rename = "on-exit")]
    OnExit {
        command: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    Stream {
        command: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        mode: Option<String>,
        #[serde(default)]
        r#match: Option<String>,
        #[serde(default)]
        batch_ms: Option<u64>,
        #[serde(default)]
        max_batch_bytes: Option<u64>,
    },
}

impl CronScheduleWire {
    fn is_valid(&self) -> bool {
        match self {
            Self::At { at } => valid_string(at),
            Self::Every {
                every_ms,
                anchor_ms,
            } => {
                *every_ms > 0
                    && valid_safe_integer(*every_ms)
                    && valid_optional_safe_integer(*anchor_ms)
            }
            Self::Cron {
                expr,
                tz,
                stagger_ms,
            } => {
                valid_string(expr)
                    && valid_optional_string(tz)
                    && valid_optional_safe_integer(*stagger_ms)
            }
            Self::OnExit { command, cwd } => valid_string(command) && valid_optional_string(cwd),
            Self::Stream {
                command,
                cwd,
                mode,
                r#match,
                batch_ms,
                max_batch_bytes,
            } => {
                !command.is_empty()
                    && command.iter().all(|value| valid_string(value))
                    && valid_optional_string(cwd)
                    && mode
                        .as_deref()
                        .is_none_or(|mode| matches!(mode, "line" | "match"))
                    && valid_optional_string(r#match)
                    && valid_optional_safe_integer(*batch_ms)
                    && valid_optional_safe_integer(*max_batch_bytes)
            }
        }
    }

    fn is_ui_projection(&self) -> bool {
        matches!(
            self,
            Self::At { .. } | Self::Every { .. } | Self::Cron { .. }
        )
    }

    fn into_view(self) -> CronScheduleView {
        match self {
            Self::At { at } => CronScheduleView::At { at },
            Self::Every {
                every_ms,
                anchor_ms,
            } => CronScheduleView::Every {
                every_ms,
                anchor_ms,
            },
            Self::Cron { expr, tz, .. } => CronScheduleView::Cron { expr, tz },
            Self::OnExit { .. } | Self::Stream { .. } => {
                panic!("validated UI cron schedule must project")
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CronWakeModeWire {
    NextHeartbeat,
    Now,
}

impl CronWakeModeWire {
    fn is_valid(&self) -> bool {
        true
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CronPayloadWire {
    SystemEvent {
        text: String,
        #[serde(default)]
        tools_allow: Option<Vec<String>>,
        #[serde(default)]
        tools_allow_is_default: Option<bool>,
    },
    AgentTurn {
        message: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        fallbacks: Option<Vec<String>>,
        #[serde(default)]
        thinking: Option<String>,
        #[serde(default)]
        timeout_seconds: Option<f64>,
        #[serde(default)]
        allow_unsafe_external_content: Option<bool>,
        #[serde(default)]
        external_content_source: Option<String>,
        #[serde(default)]
        light_context: Option<bool>,
        #[serde(default)]
        tools_allow: Option<Vec<String>>,
        #[serde(default)]
        tools_allow_is_default: Option<bool>,
    },
    Command {
        argv: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Option<Value>,
        #[serde(default)]
        input: Option<String>,
        #[serde(default)]
        timeout_seconds: Option<f64>,
        #[serde(default)]
        no_output_timeout_seconds: Option<f64>,
        #[serde(default)]
        output_max_bytes: Option<u64>,
        #[serde(default)]
        tools_allow: Option<Vec<String>>,
        #[serde(default)]
        tools_allow_is_default: Option<bool>,
    },
    Script {
        script: String,
        #[serde(default)]
        timeout_seconds: Option<f64>,
        #[serde(default)]
        tool_budget: Option<u64>,
        #[serde(default)]
        tools_allow: Option<Vec<String>>,
        #[serde(default)]
        tools_allow_is_default: Option<bool>,
    },
    Heartbeat,
    SkillCollectionReview,
}

impl CronPayloadWire {
    fn agent_turn_message(&self) -> Option<&str> {
        match self {
            Self::AgentTurn { message, .. } => Some(message),
            _ => None,
        }
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::SystemEvent {
                text,
                tools_allow,
                tools_allow_is_default,
            } => {
                let _ = tools_allow_is_default;
                valid_string(text) && valid_optional_string_vec(tools_allow)
            }
            Self::AgentTurn {
                message,
                model,
                fallbacks,
                thinking,
                timeout_seconds,
                allow_unsafe_external_content,
                external_content_source,
                light_context,
                tools_allow,
                tools_allow_is_default,
            } => {
                let _ = (
                    allow_unsafe_external_content,
                    external_content_source,
                    light_context,
                    tools_allow_is_default,
                );
                valid_string(message)
                    && valid_optional_string(model)
                    && valid_optional_string(thinking)
                    && external_content_source
                        .as_deref()
                        .is_none_or(|source| matches!(source, "gmail" | "webhook"))
                    && valid_optional_nonnegative_number(*timeout_seconds)
                    && valid_optional_string_vec(fallbacks)
                    && valid_optional_string_vec(tools_allow)
            }
            Self::Command {
                argv,
                cwd,
                env,
                input,
                timeout_seconds,
                no_output_timeout_seconds,
                output_max_bytes,
                tools_allow,
                tools_allow_is_default,
            } => {
                let _ = (env, tools_allow_is_default);
                !argv.is_empty()
                    && argv.iter().all(|value| valid_string(value))
                    && valid_optional_string(cwd)
                    && valid_optional_string(input)
                    && valid_optional_nonnegative_number(*timeout_seconds)
                    && valid_optional_nonnegative_number(*no_output_timeout_seconds)
                    && output_max_bytes
                        .as_ref()
                        .is_none_or(|value| *value > 0 && valid_safe_integer(*value))
                    && valid_optional_string_vec(tools_allow)
            }
            Self::Script {
                script,
                timeout_seconds,
                tool_budget,
                tools_allow,
                tools_allow_is_default,
            } => {
                let _ = tools_allow_is_default;
                valid_string(script)
                    && timeout_seconds
                        .as_ref()
                        .is_none_or(|value| value.is_finite() && *value >= 1.0)
                    && tool_budget
                        .as_ref()
                        .is_none_or(|value| *value > 0 && valid_safe_integer(*value))
                    && valid_optional_string_vec(tools_allow)
            }
            Self::Heartbeat | Self::SkillCollectionReview => true,
        }
    }

    fn kind(&self) -> CronPayloadKind {
        match self {
            Self::SystemEvent { .. } => CronPayloadKind::SystemEvent,
            Self::AgentTurn { .. } => CronPayloadKind::AgentTurn,
            Self::Command { .. }
            | Self::Script { .. }
            | Self::Heartbeat
            | Self::SkillCollectionReview => CronPayloadKind::SystemEvent,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronOwnerWire {
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    session_key: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
}

impl CronOwnerWire {
    fn is_valid(&self) -> bool {
        valid_optional_string(&self.agent_id)
            && valid_optional_string(&self.session_key)
            && valid_optional_string(&self.account_id)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronScheduledToolPolicyWire {
    version: u64,
    mode: String,
    #[serde(default)]
    owner_session_key: Option<String>,
    #[serde(default)]
    owner_account_id: Option<String>,
}

impl CronScheduledToolPolicyWire {
    fn is_valid(&self) -> bool {
        self.version == 1
            && matches!(self.mode.as_str(), "trusted" | "account")
            && valid_optional_string(&self.owner_session_key)
            && valid_optional_string(&self.owner_account_id)
            && (self.mode != "account"
                || (self.owner_session_key.as_deref().is_some_and(valid_string)
                    && self.owner_account_id.as_deref().is_some_and(valid_string)))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CronPacingWire {
    #[serde(default)]
    min: Option<String>,
    #[serde(default)]
    max: Option<String>,
}

impl CronPacingWire {
    fn is_valid(&self) -> bool {
        (self.min.is_some() || self.max.is_some())
            && valid_optional_string(&self.min)
            && valid_optional_string(&self.max)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CronTriggerWire {
    script: String,
    #[serde(default)]
    once: Option<bool>,
}

impl CronTriggerWire {
    fn is_valid(&self) -> bool {
        let _ = self.once;
        valid_string(&self.script)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronDeliveryWire {
    mode: String,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    thread_id: Option<Value>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    best_effort: Option<bool>,
    #[serde(default)]
    failure_destination: Option<CronFailureDestinationWire>,
    #[serde(default)]
    completion_destination: Option<CronCompletionDestinationWire>,
    #[serde(default)]
    to: Option<String>,
}

impl CronDeliveryWire {
    fn is_valid(&self) -> bool {
        let _ = (&self.thread_id, self.best_effort);
        matches!(self.mode.as_str(), "none" | "announce" | "webhook")
            && valid_optional_string(&self.channel)
            && valid_optional_string(&self.account_id)
            && valid_optional_string(&self.to)
            && (self.mode != "webhook" || self.to.as_deref().is_some_and(valid_string))
            && self
                .failure_destination
                .as_ref()
                .is_none_or(CronFailureDestinationWire::is_valid)
            && self
                .completion_destination
                .as_ref()
                .is_none_or(CronCompletionDestinationWire::is_valid)
    }

    fn is_ui_projection(&self) -> bool {
        self.mode == "none"
            || (self.mode == "announce"
                && self.channel.as_deref().is_some_and(valid_string)
                && self.to.as_deref().is_some_and(valid_string)
                && self.account_id.as_deref().is_some_and(valid_string))
    }

    fn into_view(self) -> Option<CronDeliveryView> {
        match self {
            Self { mode, .. } if mode == "none" => Some(CronDeliveryView::None),
            Self {
                mode,
                channel: Some(channel),
                to: Some(to),
                account_id: Some(account_id),
                ..
            } if mode == "announce" => Some(CronDeliveryView::Announce {
                channel,
                to,
                account_id,
            }),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronFailureDestinationWire {
    channel: Option<String>,
    to: Option<String>,
    account_id: Option<String>,
    mode: Option<String>,
}

impl CronFailureDestinationWire {
    fn is_valid(&self) -> bool {
        valid_optional_string(&self.channel)
            && valid_optional_string(&self.to)
            && valid_optional_string(&self.account_id)
            && self
                .mode
                .as_deref()
                .is_none_or(|mode| matches!(mode, "announce" | "webhook"))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronCompletionDestinationWire {
    mode: String,
    to: String,
}

impl CronCompletionDestinationWire {
    fn is_valid(&self) -> bool {
        self.mode == "webhook" && valid_string(&self.to)
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CronFailureAlertWire {
    Disabled(bool),
    Configured(CronFailureAlertConfiguredWire),
}

impl Default for CronFailureAlertWire {
    fn default() -> Self {
        Self::Disabled(false)
    }
}

impl CronFailureAlertWire {
    fn is_valid(&self) -> bool {
        match self {
            Self::Disabled(value) => !value,
            Self::Configured(value) => value.is_valid(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronFailureAlertConfiguredWire {
    after: Option<u64>,
    channel: Option<String>,
    to: Option<String>,
    cooldown_ms: Option<u64>,
    include_skipped: Option<bool>,
    mode: Option<String>,
    account_id: Option<String>,
}

impl CronFailureAlertConfiguredWire {
    fn is_valid(&self) -> bool {
        let _ = self.include_skipped;
        valid_optional_safe_integer(self.after)
            && valid_optional_safe_integer(self.cooldown_ms)
            && valid_optional_string(&self.channel)
            && valid_optional_string(&self.to)
            && self
                .mode
                .as_deref()
                .is_none_or(|mode| matches!(mode, "announce" | "webhook"))
            && valid_optional_string(&self.account_id)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronJobStateWire {
    #[serde(default)]
    next_run_at_ms: Option<u64>,
    #[serde(default)]
    schedule_activated_at_ms: Option<u64>,
    #[serde(default)]
    running_at_ms: Option<u64>,
    #[serde(default)]
    last_run_at_ms: Option<u64>,
    #[serde(default)]
    last_run_status: Option<CronRunStatusWire>,
    #[serde(default)]
    last_status: Option<CronRunStatusWire>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    last_diagnostics: Option<Value>,
    #[serde(default)]
    last_diagnostic_summary: Option<String>,
    #[serde(default)]
    last_error_reason: Option<String>,
    #[serde(default)]
    last_duration_ms: Option<u64>,
    #[serde(default)]
    consecutive_errors: Option<u64>,
    #[serde(default)]
    auto_disabled: Option<CronAutoDisabledWire>,
    #[serde(default)]
    consecutive_skipped: Option<u64>,
    #[serde(default)]
    last_delivered: Option<bool>,
    #[serde(default)]
    last_delivery_status: Option<String>,
    #[serde(default)]
    last_delivery_error: Option<String>,
    #[serde(default)]
    delivery_suppression_reason: Option<String>,
    #[serde(default)]
    last_failure_notification_delivered: Option<bool>,
    #[serde(default)]
    last_failure_notification_delivery_status: Option<String>,
    #[serde(default)]
    last_failure_notification_delivery_error: Option<String>,
    #[serde(default)]
    last_failure_alert_at_ms: Option<u64>,
    #[serde(default)]
    last_trigger_eval_at_ms: Option<u64>,
    #[serde(default)]
    trigger_eval_count: Option<u64>,
    #[serde(default)]
    last_trigger_fire_at_ms: Option<u64>,
    #[serde(default)]
    trigger_state: Option<Value>,
    #[serde(default)]
    stream_status: Option<String>,
    #[serde(default)]
    stream_error: Option<String>,
    #[serde(default)]
    stream_consecutive_failures: Option<u64>,
    #[serde(default)]
    stream_restart_exhausted: Option<bool>,
    #[serde(default)]
    stream_source_identity: Option<String>,
    #[serde(default)]
    stream_dropped_batches: Option<u64>,
    #[serde(default)]
    stream_coalesced_batches: Option<u64>,
    #[serde(default)]
    stream_last_started_at_ms: Option<u64>,
    #[serde(default)]
    stream_last_exit_at_ms: Option<u64>,
    #[serde(default)]
    schedule_error_count: Option<u64>,
}

impl CronJobStateWire {
    fn is_valid(&self) -> bool {
        let _ = (
            self.next_run_at_ms,
            self.schedule_activated_at_ms,
            &self.last_status,
            &self.last_error,
            &self.last_diagnostics,
            &self.last_diagnostic_summary,
            &self.last_error_reason,
            self.last_duration_ms,
            self.consecutive_errors,
            self.consecutive_skipped,
            self.last_delivered,
            &self.last_delivery_status,
            &self.last_delivery_error,
            &self.delivery_suppression_reason,
            self.last_failure_notification_delivered,
            &self.last_failure_notification_delivery_status,
            &self.last_failure_notification_delivery_error,
            self.last_failure_alert_at_ms,
            self.last_trigger_eval_at_ms,
            self.trigger_eval_count,
            self.last_trigger_fire_at_ms,
            &self.trigger_state,
            &self.stream_status,
            &self.stream_error,
            self.stream_consecutive_failures,
            self.stream_restart_exhausted,
            &self.stream_source_identity,
            self.stream_dropped_batches,
            self.stream_coalesced_batches,
            self.stream_last_started_at_ms,
            self.stream_last_exit_at_ms,
            self.schedule_error_count,
        );
        valid_optional_safe_integer(self.next_run_at_ms)
            && valid_optional_safe_integer(self.schedule_activated_at_ms)
            && valid_optional_safe_integer(self.running_at_ms)
            && valid_optional_safe_integer(self.last_run_at_ms)
            && valid_optional_safe_integer(self.last_duration_ms)
            && valid_optional_safe_integer(self.consecutive_errors)
            && self
                .auto_disabled
                .as_ref()
                .is_none_or(CronAutoDisabledWire::is_valid)
            && valid_optional_safe_integer(self.consecutive_skipped)
            && valid_optional_string(&self.last_error)
            && valid_optional_string(&self.last_diagnostic_summary)
            && valid_optional_string(&self.last_error_reason)
            && valid_optional_cron_delivery_status(&self.last_delivery_status)
            && valid_optional_string(&self.last_delivery_error)
            && valid_optional_string(&self.delivery_suppression_reason)
            && valid_optional_cron_delivery_status(&self.last_failure_notification_delivery_status)
            && valid_optional_string(&self.last_failure_notification_delivery_error)
            && valid_optional_safe_integer(self.last_failure_alert_at_ms)
            && valid_optional_safe_integer(self.last_trigger_eval_at_ms)
            && valid_optional_safe_integer(self.trigger_eval_count)
            && valid_optional_safe_integer(self.last_trigger_fire_at_ms)
            && self.stream_status.as_deref().is_none_or(|status| {
                matches!(
                    status,
                    "starting" | "running" | "restarting" | "stopped" | "disabled" | "error"
                )
            })
            && valid_optional_string(&self.stream_error)
            && valid_optional_string(&self.stream_source_identity)
            && valid_optional_safe_integer(self.stream_consecutive_failures)
            && valid_optional_safe_integer(self.stream_dropped_batches)
            && valid_optional_safe_integer(self.stream_coalesced_batches)
            && valid_optional_safe_integer(self.stream_last_started_at_ms)
            && valid_optional_safe_integer(self.stream_last_exit_at_ms)
            && valid_optional_safe_integer(self.schedule_error_count)
    }

    fn into_public(self) -> CronJobState {
        CronJobState {
            next_run_at_ms: self.next_run_at_ms,
            running_at_ms: self.running_at_ms,
            last_run_at_ms: self.last_run_at_ms,
            last_run_status: self
                .last_run_status
                .or(self.last_status)
                .map(CronRunStatusWire::into_public),
            last_error: self.last_error,
            last_duration_ms: self.last_duration_ms,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronAutoDisabledWire {
    reason: String,
    at_ms: u64,
    consecutive_errors: u64,
}

impl CronAutoDisabledWire {
    fn is_valid(&self) -> bool {
        matches!(
            self.reason.as_str(),
            "consecutive-failures" | "schedule-errors"
        ) && valid_safe_integer(self.at_ms)
            && self.consecutive_errors > 0
            && valid_safe_integer(self.consecutive_errors)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CronRunStatusWire {
    Ok,
    Error,
    Skipped,
}

impl CronRunStatusWire {
    fn into_public(self) -> CronRunStatus {
        match self {
            Self::Ok => CronRunStatus::Ok,
            Self::Error => CronRunStatus::Error,
            Self::Skipped => CronRunStatus::Skipped,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CronRemoveWire {
    ok: bool,
    removed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CronEventWire {
    action: String,
    job_id: String,
    #[serde(default, rename = "job")]
    _job: Option<Value>,
    #[serde(default)]
    run_at_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    status: Option<CronRunStatusWire>,
    #[serde(default)]
    completion_status: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default, rename = "diagnostics")]
    _diagnostics: Option<Value>,
    #[serde(default, rename = "delivered")]
    _delivered: Option<bool>,
    #[serde(default)]
    delivery_status: Option<String>,
    #[serde(default)]
    delivery_error: Option<String>,
    #[serde(default)]
    delivery_suppression_reason: Option<String>,
    #[serde(default, rename = "failureNotificationDelivery")]
    _failure_notification_delivery: Option<Value>,
    #[serde(default, rename = "delivery")]
    _delivery: Option<Value>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_key: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    next_run_at_ms: Option<u64>,
    #[serde(default, rename = "triggerFired")]
    _trigger_fired: Option<bool>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default, rename = "usage")]
    _usage: Option<Value>,
}

impl CronEventWire {
    fn is_valid(&self) -> bool {
        valid_string(&self.action)
            && valid_string(&self.job_id)
            && valid_optional_string(&self.run_id)
            && valid_optional_string(&self.session_id)
            && valid_optional_string(&self.session_key)
            && self
                .completion_status
                .as_deref()
                .is_none_or(|status| matches!(status, "succeeded" | "failed" | "unknown"))
            && valid_optional_string(&self.error)
            && valid_optional_string(&self.summary)
            && valid_optional_cron_delivery_status(&self.delivery_status)
            && valid_optional_string(&self.delivery_error)
            && valid_optional_string(&self.delivery_suppression_reason)
            && valid_optional_string(&self.model)
            && valid_optional_string(&self.provider)
            && valid_optional_safe_integer(self.run_at_ms)
            && valid_optional_safe_integer(self.duration_ms)
            && valid_optional_safe_integer(self.next_run_at_ms)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronRunWire {
    ok: bool,
    #[serde(default)]
    enqueued: Option<bool>,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    ran: Option<bool>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    process_instance_id: Option<String>,
}

impl CronRunWire {
    fn into_public(self) -> Option<CronRunReceipt> {
        let Self {
            ok,
            enqueued,
            run_id,
            ran,
            reason,
            process_instance_id,
        } = self;
        if !valid_optional_string(&process_instance_id) {
            return None;
        }
        match (ok, enqueued, run_id, ran, reason) {
            (true, Some(true), Some(run_id), None, None) if valid_string(&run_id) => {
                Some(CronRunReceipt {
                    outcome: CronRunReceiptOutcome::Enqueued { run_id },
                })
            }
            (true, None, None, Some(true), None) => Some(CronRunReceipt {
                outcome: CronRunReceiptOutcome::Ran,
            }),
            (true, None, None, Some(false), Some(reason)) => {
                cron_run_disposition(&reason).map(|disposition| CronRunReceipt {
                    outcome: CronRunReceiptOutcome::Skipped(disposition),
                })
            }
            (false, None, None, None, None) => Some(CronRunReceipt {
                outcome: CronRunReceiptOutcome::OutcomeUnknown,
            }),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronRunsWire {
    entries: Vec<CronRunLogEntryWire>,
    total: u64,
    offset: u64,
    limit: u64,
    has_more: bool,
    next_offset: Option<u64>,
    #[serde(default)]
    snapshot_revision: Option<String>,
    #[serde(default)]
    config_revision: Option<String>,
}

impl CronRunsWire {
    fn is_valid(&self) -> bool {
        let Some(expected_next_offset) = self.offset.checked_add(self.entries.len() as u64) else {
            return false;
        };
        self.limit > 0
            && valid_safe_integer(self.total)
            && valid_safe_integer(self.offset)
            && valid_safe_integer(self.limit)
            && self.limit <= CRON_LIST_PAGE_LIMIT
            && valid_optional_safe_integer(self.next_offset)
            && self.offset <= self.total
            && self.entries.len() as u64 <= self.limit
            && if self.has_more {
                self.next_offset == Some(expected_next_offset) && expected_next_offset < self.total
            } else {
                self.next_offset.is_none() && expected_next_offset == self.total
            }
            && valid_optional_string(&self.snapshot_revision)
            && valid_optional_string(&self.config_revision)
            && self.entries.iter().all(CronRunLogEntryWire::is_valid)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronRunLogEntryWire {
    ts: u64,
    job_id: String,
    action: String,
    status: Option<CronRunStatusWire>,
    #[serde(default)]
    completion_status: Option<String>,
    error: Option<String>,
    #[serde(default)]
    error_reason: Option<String>,
    summary: Option<String>,
    diagnostics: Option<Value>,
    delivered: Option<bool>,
    delivery_status: Option<String>,
    delivery_error: Option<String>,
    #[serde(default)]
    delivery_suppression_reason: Option<String>,
    failure_notification_delivery: Option<Value>,
    session_id: Option<String>,
    session_key: Option<String>,
    run_id: Option<String>,
    run_at_ms: Option<u64>,
    delivery: Option<Value>,
    duration_ms: Option<u64>,
    next_run_at_ms: Option<u64>,
    #[serde(default)]
    trigger_fired: Option<bool>,
    model: Option<String>,
    provider: Option<String>,
    usage: Option<Value>,
    job_name: Option<String>,
}

impl CronRunLogEntryWire {
    fn is_valid(&self) -> bool {
        let _ = (
            self.ts,
            &self.error,
            &self.summary,
            &self.diagnostics,
            self.delivered,
            &self.delivery_status,
            &self.delivery_error,
            &self.failure_notification_delivery,
            &self.session_id,
            &self.session_key,
            &self.delivery,
            self.run_at_ms,
            self.duration_ms,
            self.next_run_at_ms,
            self.trigger_fired,
            &self.model,
            &self.provider,
            &self.usage,
            &self.job_name,
        );
        valid_safe_integer(self.ts)
            && valid_optional_safe_integer(self.run_at_ms)
            && valid_optional_safe_integer(self.duration_ms)
            && valid_optional_safe_integer(self.next_run_at_ms)
            && valid_string(&self.job_id)
            && self.action == "finished"
            && self
                .completion_status
                .as_deref()
                .is_none_or(|status| matches!(status, "succeeded" | "failed" | "unknown"))
            && valid_optional_string(&self.error)
            && valid_optional_string(&self.error_reason)
            && valid_optional_string(&self.summary)
            && valid_optional_cron_delivery_status(&self.delivery_status)
            && valid_optional_string(&self.delivery_error)
            && valid_optional_string(&self.delivery_suppression_reason)
            && valid_optional_string(&self.session_id)
            && valid_optional_string(&self.session_key)
            && valid_optional_string(&self.run_id)
            && valid_optional_string(&self.model)
            && valid_optional_string(&self.provider)
            && valid_optional_string(&self.job_name)
    }

    fn into_history(self) -> CronRunHistoryEntry {
        CronRunHistoryEntry {
            job_id: self.job_id,
            run_id: self.run_id,
            session_id: self.session_id,
            session_key: self.session_key,
            timestamp_ms: self.ts,
            status: self.status.map(CronRunStatusWire::into_public),
        }
    }
}

const fn valid_safe_integer(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}

const fn valid_optional_safe_integer(value: Option<u64>) -> bool {
    match value {
        Some(value) => valid_safe_integer(value),
        None => true,
    }
}

fn valid_optional_nonnegative_number(value: Option<f64>) -> bool {
    value.is_none_or(|value| value.is_finite() && value >= 0.0)
}

fn valid_optional_string_vec(values: &Option<Vec<String>>) -> bool {
    values
        .as_ref()
        .is_none_or(|values| values.iter().all(|value| valid_string(value)))
}

fn deserialize_optional_object<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_object() {
        Ok(Some(value))
    } else {
        Err(serde::de::Error::custom("expected object"))
    }
}

fn cron_session_target(value: &str) -> Option<CronSessionTargetWire> {
    match value {
        "main" => Some(CronSessionTargetWire::Main),
        "isolated" => Some(CronSessionTargetWire::Isolated),
        "current" => Some(CronSessionTargetWire::Current),
        value if value.strip_prefix("session:").is_some_and(valid_string) => {
            Some(CronSessionTargetWire::Named)
        }
        _ => None,
    }
}

fn cron_run_disposition(value: &str) -> Option<CronRunDisposition> {
    match value {
        "already-running" => Some(CronRunDisposition::AlreadyRunning),
        "not-due" => Some(CronRunDisposition::NotDue),
        "invalid-spec" => Some(CronRunDisposition::InvalidSpec),
        "disabled" => Some(CronRunDisposition::Disabled),
        "stopped" => Some(CronRunDisposition::Stopped),
        _ => None,
    }
}

fn valid_cron_delivery_status(value: &str) -> bool {
    matches!(
        value,
        "delivered" | "not-delivered" | "unknown" | "not-requested"
    )
}

fn valid_optional_cron_delivery_status(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(valid_cron_delivery_status)
}

fn valid_job_log_id(value: &str) -> bool {
    valid_string(value) && value.trim() == value && !value.contains(['/', '\\', '\0'])
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn cron_job(
        id: &str,
        session_target: &str,
        wake_mode: &str,
        payload: Value,
        delivery: Option<Value>,
    ) -> Value {
        let mut job = json!({
            "id": id,
            "name": "cron-name",
            "enabled": true,
            "createdAtMs": 1,
            "updatedAtMs": 1,
            "schedule": {"kind": "every", "everyMs": 60_000},
            "sessionTarget": session_target,
            "wakeMode": wake_mode,
            "payload": payload,
            "failureAlert": false,
            "state": {}
        });
        if let Some(delivery) = delivery {
            job["delivery"] = delivery;
        }
        job
    }

    fn response(id: &str, payload: Value) -> GatewayResponse {
        super::super::decode_response(
            &json!({"type": "res", "id": id, "ok": true, "payload": payload}).to_string(),
            id,
        )
        .unwrap()
        .unwrap()
    }

    fn cron_job_with_numeric_observations() -> Value {
        let mut job = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "agent-turn"}),
            None,
        );
        job["schedule"]["anchorMs"] = json!(1);
        job["failureAlert"] = json!({"after": 1, "cooldownMs": 1});
        job["state"] = json!({
            "nextRunAtMs": 1,
            "runningAtMs": 1,
            "lastRunAtMs": 1,
            "lastDurationMs": 1,
            "consecutiveErrors": 1,
            "consecutiveSkipped": 1,
            "lastFailureAlertAtMs": 1,
        });
        job
    }

    fn replace_with_unsafe_integer(value: &mut Value, pointer: &str) {
        *value
            .pointer_mut(pointer)
            .expect("numeric fixture field must exist") = json!(9_007_199_254_740_992_u64);
    }

    #[test]
    fn current_bundle_methods_and_force_run_grammar_are_pinned() {
        let run = run_force_request("cron-run-1".into(), "cron-job-1".into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&run.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "cron-run-1", "method": "cron.run",
                "params": {"id": "cron-job-1", "mode": "force"}
            })
        );
        let runs = runs_request("cron-runs-1".into(), "cron-job-1".into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&runs.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "cron-runs-1", "method": "cron.runs",
                "params": {
                    "scope": "job", "id": "cron-job-1",
                    "limit": 200, "offset": 0, "sortDir": "desc"
                }
            })
        );
        assert_eq!(CRON_LIST_METHOD, "cron.list");
        assert_eq!(CRON_ADD_METHOD, "cron.add");
        assert_eq!(CRON_UPDATE_METHOD, "cron.update");
        assert_eq!(CRON_REMOVE_METHOD, "cron.remove");
        assert_eq!(CRON_RUNS_METHOD, "cron.runs");
    }

    #[test]
    fn cron_create_constructors_reject_native_invalid_payload_target_pairings() {
        assert!(matches!(
            CronJobCreate::new(
                "cron-name",
                CronSchedule::every(60_000).unwrap(),
                CronSessionTarget::Isolated,
                CronWakeMode::NextHeartbeat,
                CronPayload::system_event("system-event").unwrap(),
            ),
            Err(WireError::InvalidCronAddRequest)
        ));
    }

    #[test]
    fn native_crud_and_compatibility_patch_requests_are_exact() {
        let create = CronJobCreate::isolated_agent_turn(
            "cron-name",
            CronSchedule::every(60_000).unwrap(),
            CronWakeMode::NextHeartbeat,
            "agent-turn",
        )
        .unwrap();
        let request = add_request("cron-add-1".into(), create).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "cron-add-1", "method": "cron.add",
                "params": {
                    "name": "cron-name", "schedule": {"kind": "every", "everyMs": 60_000},
                    "sessionTarget": "isolated", "wakeMode": "next-heartbeat",
                    "payload": {"kind": "agentTurn", "message": "agent-turn"},
                    "delivery": {"mode": "none"}
                }
            })
        );
        let create = CronJobCreate::isolated_agent_turn(
            "cron-name",
            CronSchedule::cron("0 9 * * 1".into()).unwrap(),
            CronWakeMode::NextHeartbeat,
            "agent-turn",
        )
        .unwrap()
        .with_agent_id("main".into())
        .unwrap()
        .with_announcement_delivery("telegram".into(), "recipient".into(), "account".into())
        .unwrap()
        .with_enabled(false);
        let request = add_request("cron-add-ui-1".into(), create).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap()["params"],
            json!({
                "name": "cron-name", "agentId": "main", "schedule": {"kind": "cron", "expr": "0 9 * * 1"},
                "sessionTarget": "isolated", "wakeMode": "next-heartbeat",
                "payload": {"kind": "agentTurn", "message": "agent-turn"},
                "delivery": {"mode": "announce", "channel": "telegram", "to": "recipient", "accountId": "account"},
                "enabled": false
            })
        );

        let patch = || {
            CronJobPatch::update(
                CronJobUpdate::new(
                    Some("new-name".into()),
                    Some("other-agent".into()),
                    Some("new-message".into()),
                    None,
                    Some(CronSchedule::cron("30 8 * * *".into()).unwrap()),
                    Some(true),
                )
                .unwrap(),
            )
        };
        let request = update_request(
            "cron-update-ui-1".into(),
            "cron-job-1".into(),
            patch(),
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap()["params"],
            json!({
                "id": "cron-job-1",
                "patch": {
                    "name": "new-name", "agentId": "other-agent", "payload": {"kind": "agentTurn", "message": "new-message"},
                    "schedule": {"kind": "cron", "expr": "30 8 * * *"}, "enabled": true
                }
            })
        );
        let request = update_request(
            "cron-update-ui-cas-1".into(),
            "cron-job-1".into(),
            patch(),
            Some("rev-1".into()),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap()["params"]
                ["expectedConfigRevision"],
            json!("rev-1")
        );
    }

    #[test]
    fn cron_list_requests_include_disabled_jobs_and_a_bounded_page() {
        let request = list_request("cron-list-1".into(), 200).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "cron-list-1", "method": "cron.list",
                "params": {
                    "includeDisabled": true,
                    "includeDeliveryPreviews": false,
                    "limit": 200,
                    "offset": 200
                }
            })
        );
    }

    #[test]
    fn cron_job_decoder_projects_closed_ui_fields() {
        let mut wrapper_job = cron_job(
            "cron-job-wrapper",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "wrapped"}),
            None,
        );
        wrapper_job["agentId"] = json!("main");
        wrapper_job["configRevision"] = json!("config-1");
        assert_eq!(
            decode_add(response(
                "cron-add-wrapper",
                json!({
                    "created": true,
                    "job": wrapper_job,
                    "deliveryPreview": {"label": "None", "detail": "No delivery"}
                })
            ))
            .unwrap()
            .message
            .as_deref(),
            Some("wrapped")
        );

        let mut job = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({
                "kind": "agentTurn",
                "message": "scheduled message",
                "externalContentSource": "webhook"
            }),
            Some(json!({
                "mode": "announce",
                "channel": "telegram",
                "to": "recipient",
                "accountId": "account"
            })),
        );
        job["agentId"] = json!("main");
        job["schedule"] = json!({"kind": "cron", "expr": "0 9 * * 1", "tz": "UTC"});
        job["state"] = json!({"runningAtMs": 3, "lastRunAtMs": 2, "lastRunStatus": "ok"});

        let job = decode_add(response("cron-add-1", job)).unwrap();
        assert_eq!(job.id, "cron-job-1");
        assert_eq!(job.name, "cron-name");
        assert_eq!(job.agent_id.as_deref(), Some("main"));
        assert_eq!(job.message.as_deref(), Some("scheduled message"));
        assert_eq!(
            job.schedule,
            CronScheduleView::Cron {
                expr: "0 9 * * 1".into(),
                tz: Some("UTC".into()),
            }
        );
        assert_eq!(
            job.delivery,
            CronDeliveryView::Announce {
                channel: "telegram".into(),
                to: "recipient".into(),
                account_id: "account".into(),
            }
        );
        assert_eq!(job.state.running_at_ms, Some(3));
        assert_eq!(job.state.last_run_at_ms, Some(2));
        assert_eq!(job.state.last_run_status, Some(CronRunStatus::Ok));
    }

    #[test]
    fn cron_job_decoder_accepts_native_schedule_and_fails_closed_for_webhook_projection() {
        let mut at_job = cron_job(
            "cron-at",
            "isolated",
            "now",
            json!({"kind": "agentTurn", "message": "at"}),
            None,
        );
        at_job["agentId"] = json!("main");
        at_job["schedule"] = json!({"kind": "at", "at": "2026-08-08T12:00:00Z"});
        assert!(decode_add(response("cron-at", at_job)).is_ok());

        let mut on_exit = cron_job(
            "cron-on-exit",
            "isolated",
            "now",
            json!({"kind": "agentTurn", "message": "on-exit"}),
            None,
        );
        on_exit["agentId"] = json!("main");
        on_exit["schedule"] = json!({"kind": "on-exit", "command": "git status"});
        assert!(matches!(
            decode_add(response("cron-on-exit", on_exit)),
            Err(WireError::InvalidCronAdd)
        ));

        let mut stream = cron_job(
            "cron-stream",
            "isolated",
            "now",
            json!({"kind": "agentTurn", "message": "stream"}),
            None,
        );
        stream["schedule"] = json!({"kind": "stream", "command": ["node", "watch.js"]});
        assert!(matches!(
            decode_add(response("cron-stream", stream)),
            Err(WireError::InvalidCronAdd)
        ));

        let mut webhook_job = cron_job(
            "cron-webhook",
            "isolated",
            "now",
            json!({"kind": "agentTurn", "message": "webhook"}),
            Some(json!({"mode": "webhook", "to": "https://example.invalid/hook"})),
        );
        webhook_job["schedule"] = json!({"kind": "cron", "expr": "0 * * * *"});
        assert!(matches!(
            decode_add(response("cron-webhook", webhook_job)),
            Err(WireError::InvalidCronAdd)
        ));
    }

    #[test]
    fn cron_job_decoder_projects_missing_delivery_as_none_and_rejects_non_ui_delivery() {
        let mut add_job_preview = cron_job(
            "cron-job-preview",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            Some(json!({"mode": "none"})),
        );
        add_job_preview["agentId"] = json!("main");
        add_job_preview["deliveryPreview"] = json!({"label": "None", "detail": "No delivery"});
        assert!(decode_add(response("cron-add-preview", add_job_preview)).is_ok());

        let mut without_delivery = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            None,
        );
        without_delivery["agentId"] = json!("main");
        assert_eq!(
            decode_add(response("cron-add-1", without_delivery))
                .unwrap()
                .delivery,
            CronDeliveryView::None
        );

        let webhook = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            Some(json!({"mode": "webhook", "to": "https://example.invalid/hook"})),
        );
        assert!(matches!(
            decode_add(response("cron-add-1", webhook)),
            Err(WireError::InvalidCronAdd)
        ));
    }

    #[test]
    fn cron_list_projects_only_ui_crud_subset_and_accepts_page_revisions() {
        let mut isolated_agent_turn = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            None,
        );
        isolated_agent_turn["agentId"] = json!("main");
        let mut main_system_event = cron_job(
            "cron-job-2",
            "main",
            "next-heartbeat",
            json!({"kind": "systemEvent", "text": "system event"}),
            None,
        );
        main_system_event["agentId"] = json!("main");
        let mut on_exit = cron_job(
            "cron-job-3",
            "isolated",
            "now",
            json!({"kind": "agentTurn", "message": "on-exit"}),
            None,
        );
        on_exit["agentId"] = json!("main");
        on_exit["schedule"] = json!({"kind": "on-exit", "command": "git status"});
        let mut stream = cron_job(
            "cron-job-4",
            "isolated",
            "now",
            json!({"kind": "agentTurn", "message": "stream"}),
            None,
        );
        stream["agentId"] = json!("main");
        stream["schedule"] = json!({"kind": "stream", "command": ["node", "watch.js"]});
        let command_without_agent_id = cron_job(
            "cron-job-5",
            "isolated",
            "now",
            json!({"kind": "command", "argv": ["node", "task.js"]}),
            None,
        );
        let payload = json!({
            "jobs": [isolated_agent_turn, main_system_event, on_exit, stream, command_without_agent_id],
            "total": 5,
            "offset": 0,
            "limit": 50,
            "hasMore": false,
            "nextOffset": null,
            "deliveryPreviews": {},
            "snapshotRevision": "snapshot-1",
            "configRevision": "config-1",
        });

        let jobs = decode_list(response("cron-list-1", payload)).unwrap();

        assert_eq!(jobs.jobs.len(), 1);
        assert_eq!(jobs.jobs[0].id, "cron-job-1");
        assert_eq!(jobs.next_offset, None);
    }

    #[test]
    fn cron_list_accepts_missing_delivery_previews_and_rejects_non_object_when_present() {
        let job = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            None,
        );
        let payload_without_delivery_previews = json!({
            "jobs": [job.clone()],
            "total": 1,
            "offset": 0,
            "limit": 50,
            "hasMore": false,
            "nextOffset": null,
        });
        assert!(decode_list(response("cron-list-1", payload_without_delivery_previews)).is_ok());

        for delivery_previews in [json!(null), json!([]), json!("bad")] {
            let payload = json!({
                "jobs": [job.clone()],
                "total": 1,
                "offset": 0,
                "limit": 50,
                "hasMore": false,
                "nextOffset": null,
                "deliveryPreviews": delivery_previews,
            });
            assert!(matches!(
                decode_list(response("cron-list-1", payload)),
                Err(WireError::InvalidCronList)
            ));
        }
    }

    #[test]
    fn cron_decoders_accept_openclaw_8_2_additive_response_fields_without_projecting_them() {
        let mut job = cron_job(
            "cron-job-8-2",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            Some(json!({"mode": "none"})),
        );
        job["agentId"] = json!("main");
        job["declarationKey"] = json!("declaration-1");
        job["displayName"] = json!("Display name");
        job["owner"] = json!({
            "agentId": "main",
            "sessionKey": "agent:main:session",
            "accountId": "account-1"
        });
        job["scheduledToolPolicy"] = json!({
            "version": 1,
            "mode": "account",
            "ownerSessionKey": "agent:main:session",
            "ownerAccountId": "account-1"
        });
        job["pacing"] = json!({"min": "1m"});
        job["trigger"] = json!({"script": "return true", "once": true});
        job["configRevision"] = json!("config-1");
        job["state"] = json!({
            "nextRunAtMs": 10,
            "lastRunAtMs": 9,
            "lastRunStatus": "ok",
            "lastDiagnostics": {"summary": "redacted", "entries": []},
            "scheduleErrorCount": 0,
            "streamDroppedBatches": 0
        });
        job["createdActor"] = json!({"type": "human", "source": "profile", "id": "profile-1"});
        job["runtimeAuthority"] = json!({"version": 1, "runtimeId": "codex"});
        job["runtimeAuthorityRecoveryRequired"] = json!(true);
        job["skillLibrarySelections"] = json!([{ "id": "private-skill" }]);
        job["toolsAllowProvenance"] = json!({"version": 1, "source": "final-executable-surface"});
        job["toolsAllowExecTarget"] = json!({"runtimeId": "codex"});
        job["toolsAllowExecTargetRequirement"] = json!({"runtimeId": "codex"});
        job["nativeOnlyFuture"] = json!({"ignored": true});

        let jobs = decode_list(response(
            "cron-list-8-2",
            json!({
                "jobs": [job.clone()],
                "total": 1,
                "offset": 0,
                "limit": 50,
                "hasMore": false,
                "nextOffset": null,
                "deliveryPreviews": {},
                "snapshotRevision": "snapshot-1",
                "configRevision": "config-1",
                "serverClockMs": 1,
                "filtersApplied": {"includeDisabled": true}
            }),
        ))
        .unwrap();
        assert_eq!(jobs.jobs.len(), 1);
        assert_eq!(jobs.jobs[0].id, "cron-job-8-2");
        assert_eq!(jobs.jobs[0].message.as_deref(), Some("scheduled message"));
        assert_eq!(jobs.jobs[0].state.next_run_at_ms, Some(10));
        assert_eq!(jobs.jobs[0].state.last_run_status, Some(CronRunStatus::Ok));

        let updated = decode_update(response(
            "cron-update-8-2",
            json!({
                "updated": true,
                "job": job,
                "deliveryPreview": {"label": "not requested", "detail": "not requested"},
                "mutationRevision": "mutation-1",
                "serverClockMs": 1
            }),
        ))
        .unwrap();
        assert_eq!(updated.id, "cron-job-8-2");
        assert_eq!(updated.message.as_deref(), Some("scheduled message"));
    }

    #[test]
    fn cron_runs_accept_openclaw_8_2_additive_response_fields_without_projecting_them() {
        let page = decode_runs_page(response(
            "runs-8-2",
            json!({
                "entries": [{
                    "ts": 1,
                    "jobId": "cron-job-1",
                    "action": "finished",
                    "status": "error",
                    "completionStatus": "failed",
                    "error": "redacted",
                    "errorReason": "timeout",
                    "summary": "summary",
                    "diagnostics": {"summary": "diagnostic", "entries": []},
                    "delivered": false,
                    "deliveryStatus": "not-delivered",
                    "deliveryError": "no route",
                    "deliverySuppressionReason": "silent",
                    "failureNotificationDelivery": {"status": "not-requested", "future": true},
                    "delivery": {"resolved": {"ok": false, "error": "no route"}},
                    "sessionId": "session-1",
                    "sessionKey": "agent:main:session",
                    "runId": "manual:cron-job-1:1:1",
                    "runAtMs": 1,
                    "durationMs": 2,
                    "nextRunAtMs": 3,
                    "triggerFired": true,
                    "model": "model-1",
                    "provider": "provider-1",
                    "usage": {"input_tokens": 1, "future": 2},
                    "jobName": "cron-name",
                    "taskId": "task-1",
                    "storeKey": "private-store",
                    "scriptStateChanged": true,
                    "scriptState": {"private": true}
                }],
                "total": 1,
                "offset": 0,
                "limit": 50,
                "hasMore": false,
                "nextOffset": null,
                "snapshotRevision": "snapshot-1",
                "configRevision": "config-1",
                "storeKey": "private-store",
                "retention": {"ignored": true}
            }),
        ))
        .unwrap();

        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].job_id, "cron-job-1");
        assert_eq!(
            page.entries[0].run_id.as_deref(),
            Some("manual:cron-job-1:1:1")
        );
        assert_eq!(page.entries[0].session_id.as_deref(), Some("session-1"));
        assert_eq!(page.entries[0].status(), Some(CronRunStatus::Error));
        assert_eq!(page.next_offset, None);
    }

    #[test]
    fn additive_response_fields_do_not_weaken_core_cron_validation() {
        let mut job = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            None,
        );
        job["nativeOnlyFuture"] = json!({"ignored": true});
        replace_with_unsafe_integer(&mut job, "/createdAtMs");
        assert!(matches!(
            decode_list(response(
                "cron-list-invalid-core",
                json!({
                    "jobs": [job],
                    "total": 1,
                    "offset": 0,
                    "limit": 50,
                    "hasMore": false,
                    "nextOffset": null,
                    "futurePageField": true
                }),
            )),
            Err(WireError::InvalidCronList)
        ));

        assert!(matches!(
            decode_update(response(
                "cron-update-invalid-core",
                json!({
                    "updated": true,
                    "job": {
                        "id": "cron-job-1",
                        "name": "cron-name",
                        "enabled": true,
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "schedule": {"kind": "every", "everyMs": 0},
                        "sessionTarget": "isolated",
                        "wakeMode": "next-heartbeat",
                        "payload": {"kind": "agentTurn", "message": "scheduled message"},
                        "failureAlert": false,
                        "state": {},
                        "nativeOnlyFuture": true
                    },
                    "futureWrapperField": true
                }),
            )),
            Err(WireError::InvalidCronUpdate)
        ));

        assert!(matches!(
            decode_runs(response(
                "runs-invalid-core",
                json!({
                    "entries": [{
                        "ts": 1,
                        "jobId": "cron-job-1",
                        "action": "started",
                        "futureEntryField": true
                    }],
                    "total": 1,
                    "offset": 0,
                    "limit": 50,
                    "hasMore": false,
                    "nextOffset": null,
                    "futurePageField": true
                }),
            )),
            Err(WireError::InvalidCronRuns)
        ));

        let mut job = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "scheduled message"}),
            None,
        );
        job["lastDeliveryStatus"] = json!("sent");
        assert!(matches!(
            decode_update(response("cron-update-invalid-delivery-status", job)),
            Err(WireError::InvalidCronUpdate)
        ));

        assert!(matches!(
            decode_runs(response(
                "runs-invalid-delivery-status",
                json!({
                    "entries": [{
                        "ts": 1,
                        "jobId": "cron-job-1",
                        "action": "finished",
                        "deliveryStatus": "sent"
                    }],
                    "total": 1,
                    "offset": 0,
                    "limit": 50,
                    "hasMore": false,
                    "nextOffset": null,
                    "futurePageField": true
                }),
            )),
            Err(WireError::InvalidCronRuns)
        ));
    }

    #[test]
    fn cron_job_decoder_accepts_only_schema_defined_failure_alert_forms() {
        let mut disabled = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "agent-turn"}),
            None,
        );
        disabled["agentId"] = json!("main");
        assert!(decode_add(response("cron-add-1", disabled)).is_ok());

        let mut invalid = cron_job(
            "cron-job-1",
            "isolated",
            "next-heartbeat",
            json!({"kind": "agentTurn", "message": "agent-turn"}),
            None,
        );
        invalid["failureAlert"] = json!(true);
        assert!(matches!(
            decode_add(response("cron-add-1", invalid)),
            Err(WireError::InvalidCronAdd)
        ));
    }

    #[test]
    fn receipts_distinguish_enqueue_disposition_and_terminal_run_log_facts() {
        assert!(matches!(
            decode_run(response(
                "run-1",
                json!({
                    "ok": true,
                    "enqueued": true,
                    "runId": "manual:cron-job-1:1:1",
                    "processInstanceId": "gateway-process-1"
                })
            ))
            .map(CronRunReceipt::into_outcome),
            Ok(CronRunReceiptOutcome::Enqueued { .. })
        ));
        assert!(matches!(
            decode_run(response(
                "run-1",
                json!({
                    "ok": true,
                    "enqueued": true,
                    "runId": "manual:cron-job-1:1:1",
                    "future": true
                })
            ))
            .map(CronRunReceipt::into_outcome),
            Ok(CronRunReceiptOutcome::Enqueued { .. })
        ));
        assert!(matches!(
            decode_run(response(
                "run-1",
                json!({"ok": true, "ran": true, "processInstanceId": "gateway-process-1"})
            ))
            .map(CronRunReceipt::into_outcome),
            Ok(CronRunReceiptOutcome::Ran)
        ));
        assert!(matches!(
            decode_run(response(
                "run-1",
                json!({"ok": false, "processInstanceId": "gateway-process-1"})
            ))
            .map(CronRunReceipt::into_outcome),
            Ok(CronRunReceiptOutcome::OutcomeUnknown)
        ));
        for (reason, disposition) in [
            ("already-running", CronRunDisposition::AlreadyRunning),
            ("not-due", CronRunDisposition::NotDue),
            ("invalid-spec", CronRunDisposition::InvalidSpec),
            ("disabled", CronRunDisposition::Disabled),
            ("stopped", CronRunDisposition::Stopped),
        ] {
            assert!(matches!(
                decode_run(response(
                    "run-1",
                    json!({
                        "ok": true,
                        "ran": false,
                        "reason": reason,
                        "processInstanceId": "gateway-process-1"
                    })
                ))
                .map(CronRunReceipt::into_outcome),
                Ok(CronRunReceiptOutcome::Skipped(value)) if value == disposition
            ));
        }
        assert!(matches!(
            decode_runs(response(
                "runs-1",
                json!({
                    "entries": [{
                        "ts": 1,
                        "jobId": "cron-job-1",
                        "action": "finished",
                        "status": "ok",
                        "runId": "manual:cron-job-1:1:1",
                        "completionStatus": "succeeded",
                        "errorReason": "timeout",
                        "deliverySuppressionReason": "no-target",
                        "triggerFired": true
                    }],
                    "total": 1,
                    "offset": 0,
                    "limit": 50,
                    "hasMore": false,
                    "nextOffset": null,
                    "snapshotRevision": "snapshot-1",
                    "configRevision": "config-1"
                })
            )),
            Ok(CronRunLog { entries }) if entries.len() == 1 && entries[0].status == Some(CronRunStatus::Ok)
        ));
    }

    #[test]
    fn run_log_decoder_preserves_missing_terminal_status_as_ambiguous() {
        assert!(matches!(
            decode_runs(response(
                "runs-1",
                json!({
                    "entries": [{"ts": 1, "jobId": "cron-job-1", "action": "finished", "runId": "manual:cron-job-1:1:1"}],
                    "total": 1, "offset": 0, "limit": 1, "hasMore": false, "nextOffset": null
                })
            )),
            Ok(CronRunLog { entries }) if entries.len() == 1 && entries[0].status.is_none()
        ));
    }

    #[test]
    fn cron_numeric_values_must_fit_the_javascript_safe_integer_domain() {
        assert!(CronSchedule::every(MAX_SAFE_INTEGER).is_ok());
        assert!(CronSchedule::every(MAX_SAFE_INTEGER + 1).is_err());

        for pointer in [
            "/createdAtMs",
            "/updatedAtMs",
            "/schedule/everyMs",
            "/schedule/anchorMs",
            "/failureAlert/after",
            "/failureAlert/cooldownMs",
            "/state/nextRunAtMs",
            "/state/runningAtMs",
            "/state/lastRunAtMs",
            "/state/lastDurationMs",
            "/state/consecutiveErrors",
            "/state/consecutiveSkipped",
            "/state/lastFailureAlertAtMs",
        ] {
            let mut job = cron_job_with_numeric_observations();
            replace_with_unsafe_integer(&mut job, pointer);
            assert!(
                matches!(
                    decode_add(response("cron-add-1", job)),
                    Err(WireError::InvalidCronAdd)
                ),
                "{pointer} must reject a non-exact JavaScript number"
            );
        }

        for pointer in [
            "/total",
            "/offset",
            "/limit",
            "/nextOffset",
            "/entries/0/ts",
            "/entries/0/runAtMs",
            "/entries/0/durationMs",
            "/entries/0/nextRunAtMs",
        ] {
            let mut payload = json!({
                "entries": [{
                    "ts": 1, "jobId": "cron-job-1", "action": "finished", "status": "ok",
                    "runId": "manual:cron-job-1:1:1", "runAtMs": 1, "durationMs": 1, "nextRunAtMs": 1
                }],
                "total": 1, "offset": 0, "limit": 1, "hasMore": true, "nextOffset": 1
            });
            replace_with_unsafe_integer(&mut payload, pointer);
            assert!(
                matches!(
                    decode_runs(response("runs-1", payload)),
                    Err(WireError::InvalidCronRuns)
                ),
                "{pointer} must reject a non-exact JavaScript number"
            );
        }
    }

    #[test]
    fn malformed_or_unrecognized_cron_payloads_fail_closed() {
        assert_eq!(
            run_force_request("run".into(), "job".into())
                .unwrap()
                .method(),
            CRON_RUN_METHOD
        );
        assert!(runs_request("runs".into(), "bad/job".into()).is_err());
        assert!(runs_request("runs".into(), "bad\\0job".into()).is_err());
        assert!(runs_request("runs".into(), " job".into()).is_err());
        assert!(runs_request("runs".into(), "job".into()).is_ok());
        assert!(
            decode_run(response(
                "run-1",
                json!({"ok": true, "enqueued": true, "runId": "", "extra": true})
            ))
            .is_err()
        );
        for payload in [
            json!({"ok": true, "enqueued": false, "runId": "manual:cron-job-1:1:1"}),
            json!({"ok": true, "ran": false, "reason": "unknown", "processInstanceId": "gateway-process-1"}),
            json!({"ok": true, "ran": true, "reason": "not-due", "processInstanceId": "gateway-process-1"}),
            json!({"ok": false, "runId": "manual:cron-job-1:1:1"}),
            json!({"ok": false, "reason": "stopped"}),
        ] {
            assert!(matches!(
                decode_run(response("run-1", payload)),
                Err(WireError::InvalidCronRun)
            ));
        }
        assert!(decode_runs(response(
            "runs-1",
            json!({"entries": [], "total": 0, "offset": 0, "limit": 50, "hasMore": false, "nextOffset": null, "future": true})
        ))
        .is_ok());
    }
}
