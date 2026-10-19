use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{OwnedRwLockReadGuard, RwLock, watch};
use tokio::time::{Instant, timeout};

use crate::rpc;

use super::{Cli, Instance, not_sent};

pub(crate) const IDLE_WINDOW: Duration = Duration::from_secs(5 * 60);
const PREPARE_WINDOW: Duration = Duration::from_secs(10);

#[derive(Default, PartialEq, Eq)]
pub(super) enum Admission {
    #[default]
    Open,
    Sealed,
}

pub(crate) enum Preparation {
    Ready,
    Busy,
    Resident,
}

pub(super) struct Lease {
    _guard: OwnedRwLockReadGuard<Admission>,
    activity: watch::Sender<Instant>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.activity.send_replace(Instant::now());
    }
}

pub(crate) struct Control {
    cli: Cli,
    lease: Arc<Lease>,
}

impl Control {
    pub(crate) fn instance_id(&self) -> &str {
        self.cli.instance_id()
    }

    pub(crate) async fn request(&self, request: Value) -> rpc::Result<Value> {
        match request.get("subtype").and_then(Value::as_str) {
            Some("initialize") => {
                return Err(not_sent(rpc::Error::conflict(
                    "native_already_initialized",
                    "This CLI instance is already initialized",
                )));
            }
            Some("prepare_to_sleep") => {
                return Err(not_sent(rpc::Error::conflict(
                    "native_sleep_owner_required",
                    "Only the Session owner may prepare a CLI handoff",
                )));
            }
            _ => {}
        }
        self.cli.initialized().await.map_err(not_sent)?;
        self.cli
            .0
            .instance
            .request_admitted(request, Some(self.lease.clone()))
            .await
    }

    pub(crate) async fn respond(&self, request_id: &str, response: Value) -> rpc::Result<()> {
        let cli = self.cli.clone();
        let admission = self.lease.clone();
        let request_id = request_id.to_owned();
        // A disconnected responder cannot release the gate before its frame flush.
        tokio::spawn(async move {
            let _admission = admission;
            cli.respond_admitted(&request_id, response).await
        })
        .await
        .map_err(|error| {
            rpc::Error::new(
                -32006,
                "native_response_submission_unknown",
                "Native response submission could not be confirmed",
            )
            .with_data(json!({ "instanceId": self.instance_id(), "delivery": "unknown" }))
            .with_source(error)
        })?
    }
}

impl Cli {
    pub(crate) fn admit(&self) -> rpc::Result<Control> {
        let lease = self.0.instance.admit()?;
        Ok(Control {
            cli: self.clone(),
            lease: Arc::new(lease),
        })
    }

    pub(crate) fn last_activity(&self) -> Instant {
        *self.0.instance.activity.borrow()
    }

    pub(crate) fn activity(&self) -> watch::Receiver<Instant> {
        self.0.instance.activity.subscribe()
    }

    pub(crate) fn exited_gracefully(&self) -> bool {
        !self
            .0
            .instance
            .output_fault
            .load(std::sync::atomic::Ordering::Acquire)
            && self.0.instance.process.exited_gracefully()
    }

    pub(crate) async fn prepare_to_sleep(&self) -> rpc::Result<Preparation> {
        let instance = &self.0.instance;
        let Ok(mut admission) = timeout(PREPARE_WINDOW, instance.admission.write()).await else {
            return Ok(Preparation::Busy);
        };
        instance.ensure_open()?;
        if *admission != Admission::Open {
            return Err(sealed());
        }
        // Completion, not admission time, starts the continuous inactivity window.
        if self.last_activity().elapsed() < IDLE_WINDOW {
            return Ok(Preparation::Busy);
        }
        *admission = Admission::Sealed;
        let response = timeout(
            PREPARE_WINDOW,
            instance.request_admitted(json!({ "subtype": "prepare_to_sleep" }), None),
        )
        .await
        .map_err(|_| {
            rpc::Error::new(
                -32006,
                "native_sleep_ack_unknown",
                "Native sleep preparation was not confirmed",
            )
            .with_data(json!({ "instanceId": self.instance_id(), "delivery": "unknown" }))
        })??;
        match response.get("status").and_then(Value::as_str) {
            Some("ready") => Ok(Preparation::Ready),
            Some("busy") => {
                *admission = Admission::Open;
                Ok(Preparation::Busy)
            }
            Some("resident") => {
                *admission = Admission::Open;
                Ok(Preparation::Resident)
            }
            _ => Err(rpc::Error::new(
                -32006,
                "native_sleep_response_invalid",
                "The native sleep response is invalid",
            )
            .with_data(json!({ "instanceId": self.instance_id(), "delivery": "sent" }))),
        }
    }
}

impl Instance {
    fn admit(&self) -> rpc::Result<Lease> {
        self.activity.send_replace(Instant::now());
        let guard = Arc::clone(&self.admission)
            .try_read_owned()
            .map_err(|_| sealed())?;
        if *guard != Admission::Open {
            return Err(sealed());
        }
        self.ensure_open()?;
        Ok(Lease {
            _guard: guard,
            activity: self.activity.clone(),
        })
    }

    pub(super) async fn request(&self, request: Value) -> rpc::Result<Value> {
        let lease = Arc::new(self.admit()?);
        self.request_admitted(request, Some(lease)).await
    }
}

pub(super) fn admission() -> Arc<RwLock<Admission>> {
    Arc::new(RwLock::new(Admission::Open))
}

fn sealed() -> rpc::Error {
    not_sent(rpc::Error::unavailable(
        "native_instance_sealed",
        "This CLI instance is handing off; the control request was not sent",
    ))
}
