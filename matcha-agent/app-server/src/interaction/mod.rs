mod native;
mod store;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    events::Events,
    persistence::Database,
    rpc::{self, Error},
    session::Sessions,
};

use native::{Category, Request};
use store::Store;

#[derive(Clone)]
pub struct Interactions {
    store: Store,
    events: Events,
    publication: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    invalidations: Arc<Mutex<Invalidations>>,
}

#[derive(Default)]
struct Invalidations {
    instances: HashSet<(String, String)>,
    requests: HashSet<Target>,
}

#[derive(Clone, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    session_id: String,
    instance_id: String,
    native_request_id: String,
}

impl Target {
    fn validate(&self) -> rpc::Result<()> {
        if self.session_id.is_empty()
            || self.instance_id.is_empty()
            || self.native_request_id.is_empty()
        {
            return Err(Error::invalid(
                "sessionId, instanceId and nativeRequestId must be nonempty",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    session_id: String,
    run_id: Option<String>,
    instance_id: String,
    native_request_id: String,
    category: Category,
    request: Request,
    availability: Availability,
    delivery: Delivery,
    requested_at_ms: u64,
    updated_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<Failure>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Availability {
    Pending,
    NativeCancelled,
    InstanceClosed,
    ServerRestarted,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Delivery {
    NotSent,
    Sending,
    Sent,
    WriteFailed,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    code: i64,
    kind: String,
}

impl Failure {
    fn from_error(error: &Error) -> Self {
        Self {
            code: error.code,
            kind: error
                .data
                .as_ref()
                .and_then(|data| data.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("interaction_response_failed")
                .to_owned(),
        }
    }
}

impl Pending {
    fn receipt(&self) -> Value {
        json!({
            "sessionId": self.session_id, "runId": self.run_id, "instanceId": self.instance_id,
            "nativeRequestId": self.native_request_id, "category": self.category,
            "availability": self.availability, "delivery": self.delivery,
            "nativeApplication": if matches!(self.delivery, Delivery::NotSent | Delivery::WriteFailed) { "notSubmitted" } else { "unknown" },
            "requestedAtMs": self.requested_at_ms, "updatedAtMs": self.updated_at_ms,
            "failure": self.failure,
        })
    }

    fn view(&self) -> rpc::Result<Value> {
        let mut view = rpc::value(self)?;
        view["nativeApplication"] = self.receipt()["nativeApplication"].clone();
        Ok(view)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    session_id: String,
    run_id: Option<String>,
    instance_id: Option<String>,
    #[serde(default)]
    include_resolved: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RespondParams {
    session_id: String,
    instance_id: String,
    native_request_id: String,
    response: Value,
}

impl Interactions {
    pub async fn open(database: Database, events: Events) -> rpc::Result<Self> {
        let store = Store::open(database).await?;
        let interactions = Self {
            store,
            events,
            publication: Arc::new(Mutex::new(HashMap::new())),
            invalidations: Arc::new(Mutex::new(Invalidations::default())),
        };
        for session_id in interactions.store.fact_sessions().await? {
            interactions.publish(&session_id).await?;
        }
        Ok(interactions)
    }

    pub async fn observe(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        instance_id: &str,
        request_id: &str,
        request: Value,
    ) -> rpc::Result<()> {
        let target = Target {
            session_id: session_id.to_owned(),
            instance_id: instance_id.to_owned(),
            native_request_id: request_id.to_owned(),
        };
        target.validate()?;
        let request =
            Request::decode(request).map_err(|error| error.with_data(correlation(&target)))?;
        if self.blocked(&target)? {
            return Err(Error::unavailable(
                "interaction_invalidated",
                "The interaction was cancelled or its CLI instance closed",
            )
            .with_data(correlation(&target)));
        }
        self.store
            .observe(target.clone(), run_id.map(str::to_owned), request)
            .await
            .map_err(|error| error.with_data(correlation(&target)))?;
        self.publish(session_id).await
    }

    // These are observations of native cancellation/instance loss, never commands
    // to deny a tool or assertions that any tool/run side effect was cancelled.
    pub async fn cancel(
        &self,
        session_id: &str,
        instance_id: &str,
        request_id: &str,
    ) -> rpc::Result<()> {
        let target = Target {
            session_id: session_id.to_owned(),
            instance_id: instance_id.to_owned(),
            native_request_id: request_id.to_owned(),
        };
        target.validate()?;
        self.invalidations
            .lock()
            .map_err(|_| Error::internal("interaction_invalidation_lock"))?
            .requests
            .insert(target.clone());
        self.store.cancel(target.clone()).await.map_err(|error| error.with_data(json!({
            "nativeCancellationObserved": true, "sessionId": session_id, "instanceId": instance_id, "nativeRequestId": request_id,
        })))?;
        self.invalidations
            .lock()
            .map_err(|_| Error::internal("interaction_invalidation_lock"))?
            .requests
            .remove(&target);
        self.publish(session_id).await
    }

    pub async fn close_instance(&self, session_id: &str, instance_id: &str) -> rpc::Result<()> {
        if session_id.is_empty() || instance_id.is_empty() {
            return Err(Error::invalid("sessionId and instanceId must be nonempty"));
        }
        let instance = (session_id.to_owned(), instance_id.to_owned());
        self.invalidations
            .lock()
            .map_err(|_| Error::internal("interaction_invalidation_lock"))?
            .instances
            .insert(instance.clone());
        self.store.close_instance(session_id.to_owned(), instance_id.to_owned()).await
            .map_err(|error| error.with_data(json!({"instanceClosedObserved": true, "sessionId": session_id, "instanceId": instance_id})))?;
        {
            let mut blocked = self
                .invalidations
                .lock()
                .map_err(|_| Error::internal("interaction_invalidation_lock"))?;
            blocked.instances.remove(&instance);
            blocked.requests.retain(|request| {
                request.session_id != session_id || request.instance_id != instance_id
            });
        }
        self.publish(session_id).await
    }

    pub async fn dispatch(
        &self,
        method: &str,
        params: Value,
        sessions: &Sessions,
    ) -> rpc::Result<Value> {
        let (family, respond) = match method {
            "approvals.list" => ("approvals", false),
            "approvals.respond" => ("approvals", true),
            "questions.list" => ("questions", false),
            "questions.respond" => ("questions", true),
            "hooks.pending" => ("hooks", false),
            "hooks.respond" => ("hooks", true),
            _ => return Err(Error::method(method)),
        };
        if !respond {
            let params: ListParams = rpc::params(params)?;
            if params.session_id.is_empty() {
                return Err(Error::invalid("sessionId must be nonempty"));
            }
            self.publish(&params.session_id).await?;
            let pending = self
                .store
                .list(
                    params.session_id,
                    family.to_owned(),
                    params.run_id,
                    params.instance_id,
                    params.include_resolved,
                )
                .await?;
            return Ok(
                json!({"items": pending.iter().map(Pending::view).collect::<rpc::Result<Vec<_>>>()?}),
            );
        }
        let params: RespondParams = rpc::params(params)?;
        let target = Target {
            session_id: params.session_id,
            instance_id: params.instance_id,
            native_request_id: params.native_request_id,
        };
        target.validate()?;
        let interactions = self.clone();
        let sessions = sessions.clone();
        // A socket/request future can disappear while the write is in flight.
        // Keep this single decision's reservation/write/settlement alive, without
        // retaining a process handle or retrying an uncertain native side effect.
        tokio::spawn(async move { interactions.respond(target, family, params.response, &sessions).await })
            .await.map_err(|source| Error::new(-32006, "interaction_response_task_lost", "Response delivery could not be confirmed; query the interaction before taking further action")
                .with_source(source).with_data(json!({"delivery": "unknown"})))?
    }

    async fn respond(
        &self,
        target: Target,
        family: &str,
        response: Value,
        sessions: &Sessions,
    ) -> rpc::Result<Value> {
        if self.blocked(&target)? {
            return Err(Error::conflict(
                "interaction_invalidated",
                "Native cancellation or instance closure has already been observed",
            )
            .with_data(correlation(&target)));
        }
        let reservation = self
            .store
            .reserve(target.clone(), family.to_owned(), response)
            .await
            .map_err(|error| {
                error
                    .with_data(correlation(&target))
                    .with_data(json!({"responseAttemptDelivery": "notSent"}))
            })?;
        if !reservation.should_send {
            let result = repeated(&reservation.pending);
            let publication = self.publish(&target.session_id).await;
            return match (result, publication) {
                (Ok(receipt), Ok(())) => Ok(receipt),
                (Ok(receipt), Err(error)) => Err(error.with_data(receipt)),
                (Err(error), publication) => Err(combine(
                    error,
                    publication.err(),
                    reservation.pending.receipt(),
                )),
            };
        }
        let pending = reservation.pending;
        // Publish reservation facts before sending; an Events failure must never
        // turn an unrecorded approval into a tool execution.
        if let Err(event_error) = self.publish(&target.session_id).await {
            let finish = self
                .store
                .finish(
                    target.clone(),
                    Delivery::NotSent,
                    Some(Failure::from_error(&event_error)),
                )
                .await;
            let mut receipt = pending.receipt();
            receipt["delivery"] = json!("notSent");
            receipt["nativeApplication"] = json!("notSubmitted");
            if finish.is_err() {
                receipt["persistence"] = json!("unconfirmed");
            }
            return Err(combine(event_error, finish.err(), receipt));
        }
        let mut submission_attempted = false;
        let result = async {
            if self.blocked(&target)? {
                return Err(Error::conflict(
                    "interaction_invalidated",
                    "The native request was invalidated before response submission",
                ));
            }
            if !self.store.answerable(target.clone()).await? {
                return Err(Error::conflict("interaction_no_longer_pending", "The native request was cancelled or its instance closed before response submission"));
            }
            let response = pending.response.clone()
                .ok_or_else(|| Error::internal("interaction_reserved_response_missing"))?;
            submission_attempted = true;
            sessions.respond(&target.session_id, &target.instance_id, &target.native_request_id, response).await
        }.await.map_err(|error| if submission_attempted { error } else { error.with_data(json!({"delivery": "notSent"})) });
        let delivery = match &result {
            Ok(()) => Delivery::Sent,
            Err(_) if !submission_attempted => Delivery::NotSent,
            Err(error)
                if error
                    .data
                    .as_ref()
                    .and_then(|data| data.get("delivery"))
                    .and_then(Value::as_str)
                    == Some("notSent") =>
            {
                Delivery::WriteFailed
            }
            Err(_) => Delivery::Unknown,
        };
        let failure = result.as_ref().err().map(Failure::from_error);
        let settled = self.store.finish(target.clone(), delivery, failure).await;
        let (settled, storage_error) = match settled {
            Ok(pending) => (Some(pending), None),
            Err(error) => (None, Some(error)),
        };
        let event_error = self.publish(&target.session_id).await.err();
        let receipt = settled.as_ref().map(Pending::receipt).unwrap_or_else(|| {
            let mut receipt = pending.receipt();
            receipt["delivery"] = json!(delivery);
            receipt["nativeApplication"] = json!(if matches!(
                delivery,
                Delivery::WriteFailed | Delivery::NotSent
            ) {
                "notSubmitted"
            } else {
                "unknown"
            });
            receipt["persistence"] = json!("unconfirmed");
            receipt
        });
        if let Err(error) = result {
            return Err(combine(
                combine(error, storage_error, receipt.clone()),
                event_error,
                receipt,
            ));
        }
        if let Some(error) = storage_error {
            return Err(combine(error, event_error, receipt));
        }
        if let Some(error) = event_error {
            return Err(error.with_data(receipt));
        }
        Ok(receipt)
    }

    fn blocked(&self, target: &Target) -> rpc::Result<bool> {
        let blocked = self
            .invalidations
            .lock()
            .map_err(|_| Error::internal("interaction_invalidation_lock"))?;
        Ok(blocked
            .instances
            .contains(&(target.session_id.clone(), target.instance_id.clone()))
            || blocked.requests.contains(target))
    }

    pub async fn delete_session(&self, session_id: &str) -> rpc::Result<()> {
        if session_id.is_empty() {
            return Err(Error::invalid("sessionId must be nonempty"));
        }
        let lock = self.publication_lock(session_id)?;
        let _guard = lock.lock().await;
        self.store.delete_session(session_id.to_owned()).await?;
        let mut blocked = self
            .invalidations
            .lock()
            .map_err(|_| Error::internal("interaction_invalidation_lock"))?;
        blocked
            .instances
            .retain(|(session, _)| session != session_id);
        blocked
            .requests
            .retain(|target| target.session_id != session_id);
        Ok(())
    }

    fn publication_lock(&self, session_id: &str) -> rpc::Result<Arc<AsyncMutex<()>>> {
        let mut locks = self
            .publication
            .lock()
            .map_err(|_| Error::internal("interaction_publication_lock"))?;
        locks.retain(|_, lock| lock.strong_count() != 0);
        let lock = locks
            .get(session_id)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(AsyncMutex::new(())));
        locks.insert(session_id.to_owned(), Arc::downgrade(&lock));
        Ok(lock)
    }

    async fn publish(&self, session_id: &str) -> rpc::Result<()> {
        let lock = self.publication_lock(session_id)?;
        let _guard = lock.lock().await;
        while let Some(fact) = self.store.next_fact(session_id.to_owned()).await? {
            self.events.append(&fact.session_id, fact.run_id.as_deref(), &fact.kind, fact.payload).await
                .map_err(|error| error.with_data(json!({"interactionPersisted": true, "eventPublication": "unconfirmed", "sessionId": session_id})))?;
            self.store.acknowledge_fact(fact.id).await.map_err(|error| error.with_data(json!({
                "eventPublication": "appended", "factAcknowledgement": "unconfirmed", "sessionId": session_id,
            })))?;
        }
        Ok(())
    }
}

fn repeated(pending: &Pending) -> rpc::Result<Value> {
    let receipt = pending.receipt();
    match pending.delivery {
        Delivery::Sent => Ok(receipt),
        Delivery::Sending => Err(Error::new(
            -32006,
            "interaction_response_delivery_unconfirmed",
            "A response is reserved but its delivery has not been recorded; it will not be resent",
        )
        .with_data(receipt)),
        Delivery::Unknown => Err(Error::new(
            -32006,
            "interaction_response_delivery_unknown",
            "The previous response may have been delivered; it will not be resent",
        )
        .with_data(receipt)),
        Delivery::WriteFailed => Err(Error::conflict(
            "interaction_response_write_failed",
            "The previous response was not sent; this decision will not be replayed automatically",
        )
        .with_data(receipt)),
        Delivery::NotSent => Err(Error::conflict(
            "interaction_response_not_sendable",
            "This interaction has no response eligible for submission",
        )
        .with_data(receipt)),
    }
}

fn correlation(target: &Target) -> Value {
    json!({"sessionId": target.session_id, "instanceId": target.instance_id, "nativeRequestId": target.native_request_id})
}

fn combine(primary: Error, secondary: Option<Error>, facts: Value) -> Error {
    let primary = primary.with_data(facts);
    match secondary {
        Some(secondary) => {
            let mut failures = primary
                .data
                .as_ref()
                .and_then(|data| data.get("relatedFailures"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            failures.push(json!(Failure::from_error(&secondary)));
            primary
                .clone()
                .with_data(json!({"relatedFailures": failures}))
                .with_source(CombinedFailure { primary, secondary })
        }
        None => primary,
    }
}

struct CombinedFailure {
    primary: Error,
    secondary: Error,
}

impl std::fmt::Debug for CombinedFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Interaction primary and secondary failures")
    }
}

impl std::fmt::Display for CombinedFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}; secondary: {}", self.primary, self.secondary)
    }
}

impl std::error::Error for CombinedFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.primary)
    }
}
