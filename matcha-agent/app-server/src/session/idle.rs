use std::sync::{Arc, atomic::Ordering};

use serde_json::json;
use tokio::time::Instant;

use crate::{
    cli::idle::{IDLE_WINDOW, Preparation},
    rpc,
};

use super::{Execution, Session, Sessions, history, record};

pub(super) enum Idle {
    Dormant,
    Watching { since: Instant },
    Resident { observed_activity: Instant },
    Handoff,
}

impl Idle {
    pub fn handing_off(&self) -> bool {
        matches!(self, Self::Handoff)
    }

    pub fn activity(&mut self) {
        if !self.handing_off() {
            *self = Self::Watching {
                since: Instant::now(),
            };
        }
    }
}

impl Execution {
    fn sleep_candidate(&self) -> bool {
        self.cli.is_some()
            && self.native.initialize.is_some()
            && self.record.status == record::Status::Open
            && !self.record.native_cleanup_failed
            && self.storage_fault.is_none()
            && !self.launching
            && !self.closing
            && !self.sending
            && !self.cancel_in_flight
            && self.consuming
            && self.active.is_none()
            && self.queue.is_empty()
            && !self.native.busy
    }

    pub(super) fn idle_deadline(&mut self) -> Option<Instant> {
        if self.idle.handing_off() {
            return None;
        }
        if !self.sleep_candidate() {
            self.idle = Idle::Dormant;
            return None;
        }
        let activity = self
            .cli
            .as_ref()
            .expect("sleep candidate CLI")
            .last_activity();
        let since = match self.idle {
            Idle::Watching { since } => since.max(activity),
            Idle::Resident { observed_activity } if activity <= observed_activity => return None,
            _ => Instant::now(),
        };
        self.idle = Idle::Watching { since };
        Some(since + IDLE_WINDOW)
    }
}

impl Sessions {
    pub(super) async fn sleep_instance(&self, session: Arc<Session>) {
        // Permanent close and idle handoff cannot own the same consumer join.
        let Ok(_closing) = session.close_guard.try_lock() else {
            return;
        };
        // Search holds this existing guard from instance lookup through readback.
        let _search = self.search_guard().await;
        let cli = {
            let mut execution = session.data.lock().await;
            if self.0.shutdown.load(Ordering::Acquire)
                || execution
                    .idle_deadline()
                    .is_none_or(|deadline| deadline > Instant::now())
            {
                return;
            }
            execution.idle = Idle::Handoff;
            execution.cli.as_ref().expect("sleep candidate CLI").clone()
        };
        let prepared = cli.prepare_to_sleep().await;
        if matches!(prepared, Ok(Preparation::Busy | Preparation::Resident)) {
            let mut execution = session.data.lock().await;
            if execution
                .cli
                .as_ref()
                .is_some_and(|current| current.instance_id() == cli.instance_id())
            {
                execution.idle = if matches!(prepared, Ok(Preparation::Resident)) {
                    Idle::Resident {
                        observed_activity: cli.last_activity(),
                    }
                } else {
                    Idle::Watching {
                        since: Instant::now(),
                    }
                };
            }
            session.changed.notify_waiters();
            session.wake.notify_one();
            return;
        }
        let ready = matches!(prepared, Ok(Preparation::Ready));
        let closed = cli.close().await;
        self.cleanup_result(&session, cli.instance_id(), &closed)
            .await;
        let joined = match session.consumer.lock().await.take() {
            Some(task) => task
                .await
                .map_err(|error| rpc::Error::internal("session_consumer_task").with_source(error)),
            None => Err(rpc::Error::internal("session_consumer_missing")),
        };
        let mut execution = session.data.lock().await;
        if let Err(error) = &joined {
            execution.fault(error.clone());
        }
        let transcript = async {
            let path = history::locate(
                &execution.record.runtime,
                &execution.record.workspace,
                &execution.record.session_id,
            )
            .await?;
            if execution.record.native_started && path.is_none() {
                return Err(rpc::Error::not_found("Native transcript"));
            }
            if let Some(path) = path {
                let mut persisted = execution.record.clone();
                persisted.native_started = true;
                persisted.transcript = Some(path);
                record::save_session(&self.0.database, &persisted).await?;
                execution.record = persisted;
            }
            Ok(())
        }
        .await;
        if let Err(error) = &transcript {
            execution.fault(error.clone());
        }
        let safe = ready
            && closed.is_ok()
            && joined.is_ok()
            && transcript.is_ok()
            && execution.storage_fault.is_none()
            && !execution.record.native_cleanup_failed
            && cli.exited_gracefully();
        let kind = if safe {
            "native_sleep_safe"
        } else if !ready {
            "native_sleep_prepare_unconfirmed"
        } else if closed.is_err() || joined.is_err() {
            "native_sleep_cleanup_unconfirmed"
        } else if transcript.is_err() {
            "native_sleep_transcript_unconfirmed"
        } else if execution.storage_fault.is_some() {
            "native_sleep_observation_unconfirmed"
        } else {
            "native_sleep_exit_not_graceful"
        };
        let cause = prepared
            .err()
            .or_else(|| closed.as_ref().err().cloned())
            .or_else(|| joined.as_ref().err().cloned())
            .or_else(|| transcript.err())
            .or_else(|| execution.storage_fault.clone());
        let mut context = json!({
            "sessionId": execution.record.session_id,
            "agentId": execution.record.agent_id,
            "instanceId": cli.instance_id(),
            "stage": if ready { "ready_acknowledged" } else { "prepare_unknown" },
            "cleanupComplete": closed.is_ok() && joined.is_ok(),
            "outcomeUnknown": !safe,
        });
        if let Some(cause) = cause {
            context["causeCode"] = json!(cause.code);
            if let Some(data) = cause.data {
                context["causeKind"] = data.get("kind").cloned().unwrap_or_default();
            }
        }
        execution.idle = Idle::Dormant;
        drop(execution);
        if self
            .0
            .diagnostics
            .record("session", "idle", kind, context)
            .await
            .is_err()
        {
            eprintln!("session idle diagnostic could not be persisted");
        }
        session.changed.notify_waiters();
        // These queued inputs have never been sent. Recovery still uses the same
        // UUID and existing transcript validation, never a fallback session.
        session.wake.notify_one();
    }
}
