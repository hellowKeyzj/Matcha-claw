use std::sync::{Arc, atomic::Ordering};

use crate::{cli::Cli, rpc};
use serde_json::{Value, json};

use super::{Session, Sessions, combined, native, record, run};

impl Sessions {
    pub(super) async fn start_executor(&self, session: Arc<Session>) {
        let owner = self.clone();
        let executing = session.clone();
        let task = tokio::spawn(async move {
            loop {
                let (deadline, activity) = {
                    let mut execution = executing.data.lock().await;
                    let activity = execution.cli.as_ref().map(Cli::activity);
                    (execution.idle_deadline(), activity)
                };
                let sleep = tokio::select! {
                    _ = executing.stopped.cancelled() => break,
                    _ = executing.wake.notified() => false,
                    _ = async {
                        match activity {
                            Some(mut activity) => { let _ = activity.changed().await; }
                            None => std::future::pending::<()>().await,
                        }
                    } => false,
                    _ = async {
                        match deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline).await,
                            None => std::future::pending::<()>().await,
                        }
                    } => true,
                };
                if owner.0.shutdown.load(Ordering::Acquire) {
                    break;
                }
                if sleep {
                    owner.sleep_instance(executing.clone()).await;
                }
                if let Err(error) = owner.advance(executing.clone()).await {
                    owner.execution_fault(&executing, error).await;
                }
            }
        });
        *session.executor.lock().await = Some(task);
    }

    async fn advance(&self, session: Arc<Session>) -> rpc::Result<()> {
        let agent_id = session.data.lock().await.record.agent_id.clone();
        let admission = tokio::select! {
            _ = session.stopped.cancelled() => return Ok(()),
            guard = self.agent_guard(&agent_id) => guard,
        };
        let config = self.0.config.snapshot().await;
        let mut execution = session.data.lock().await;
        if execution.closing
            || execution.idle.handing_off()
            || execution.launching
            || (execution.consuming && execution.cli.is_none())
            || execution.record.status != record::Status::Open
            || execution.record.native_cleanup_failed
            || execution.storage_fault.is_some()
            || execution.active.is_some()
            || execution.cancel_in_flight
            || execution.native.busy
            || execution.queue.is_empty()
            || self.0.shutdown.load(Ordering::Acquire)
        {
            return Ok(());
        }
        let mut pending = execution
            .queue
            .front()
            .expect("nonempty session queue")
            .clone();
        pending.run.status = run::Status::Starting;
        pending.run.started_at_ms = Some(rpc::now_ms());
        self.save_run_locked(&mut execution, &pending).await?;
        execution.queue.pop_front();
        let run_id = pending.run.run_id.clone();
        execution.active = Some(run::Active {
            record: pending,
            acknowledged: false,
            input_started: false,
            native_cycle_observed: false,
            interrupt_observed: false,
            ownership_ambiguous: execution
                .cli
                .as_ref()
                .is_some_and(Cli::has_autonomous_inputs)
                || matches!(
                    execution.native.proactive,
                    native::Proactive::Enabled | native::Proactive::OutcomeUnknown
                ),
            result_count: 0,
            result: None,
        });
        execution.sending = true;
        let existing = execution.cli.clone();
        let launch = if existing.is_none() {
            execution.launching = true;
            execution.launch_error = None;
            match self.launch_spec(config, &execution) {
                Ok(spec) => Some(spec),
                Err(error) => {
                    drop(execution);
                    drop(admission);
                    self.fail_before_send(&session, "native_launch_selection_failed", &error)
                        .await?;
                    return Ok(());
                }
            }
        } else {
            None
        };
        drop(execution);
        drop(admission);
        let cli = match launch {
            Some(spec) => match self.start_instance(&session, spec).await {
                Ok(cli) => {
                    session.data.lock().await.launching = false;
                    session.changed.notify_waiters();
                    cli
                }
                Err(error) => {
                    self.fail_before_send(&session, "native_start_failed", &error)
                        .await?;
                    return Ok(());
                }
            },
            None => existing.expect("existing CLI or launch specification"),
        };
        let mut execution = session.data.lock().await;
        if execution.closing
            || self.0.shutdown.load(Ordering::Acquire)
            || execution
                .active
                .as_ref()
                .is_none_or(|active| active.record.run.run_id != run_id)
        {
            execution.sending = false;
            session.changed.notify_waiters();
            return Ok(());
        }
        let active = execution.active.as_mut().expect("active run checked");
        if active.record.run.cancel_requested_at_ms.is_some() {
            self.finish_locked(
                &mut execution,
                run::Status::Cancelled,
                "cancelled_before_send",
                None,
            )
            .await?;
            execution.sending = false;
            session.changed.notify_waiters();
            session.wake.notify_one();
            return Ok(());
        }
        let mut running = active.record.clone();
        running.run.status = run::Status::Running;
        self.save_run_locked(&mut execution, &running).await?;
        let active = execution.active.as_mut().expect("active run checked");
        active.record = running;
        active.input_started = true;
        let message_id = active.record.run.message_id.clone();
        let content = active
            .record
            .content
            .clone()
            .expect("nonterminal run retains submitted content");
        let session_id = execution.record.session_id.clone();
        drop(execution);
        let sent = cli.send_user(&session_id, &message_id, content).await;
        let mut execution = session.data.lock().await;
        execution.sending = false;
        session.changed.notify_waiters();
        match sent {
            Ok(()) => {
                if let Some(active) = execution
                    .active
                    .as_ref()
                    .filter(|active| active.record.run.run_id == run_id)
                {
                    let mut delivered = active.record.clone();
                    delivered.content = None;
                    self.save_run_locked(&mut execution, &delivered).await?;
                    execution
                        .active
                        .as_mut()
                        .expect("active run checked")
                        .record = delivered;
                }
            }
            Err(error) => {
                if execution
                    .active
                    .as_ref()
                    .is_some_and(|active| active.record.run.run_id == run_id)
                {
                    let status = if error
                        .data
                        .as_ref()
                        .and_then(|data| data.get("delivery"))
                        .and_then(Value::as_str)
                        == Some("notSent")
                    {
                        run::Status::Failed
                    } else {
                        run::Status::OutcomeUnknown
                    };
                    self.finish_locked(&mut execution, status, "native_prompt_send_failed", None)
                        .await?;
                }
                drop(execution);
                let closed = cli.close().await;
                self.cleanup_result(&session, cli.instance_id(), &closed)
                    .await;
                let failure = match closed {
                    Ok(()) => error,
                    Err(cleanup) => error.with_data(json!({ "cleanupFailure": cleanup })),
                };
                let context = {
                    let execution = session.data.lock().await;
                    failure_context(&execution, &failure)
                };
                if self
                    .0
                    .diagnostics
                    .record("session", "execute", "native_prompt_send_failed", context)
                    .await
                    .is_err()
                {
                    eprintln!("session send diagnostic could not be persisted");
                }
                return Ok(());
            }
        }
        Ok(())
    }

    async fn fail_before_send(
        &self,
        session: &Session,
        reason: &str,
        error: &rpc::Error,
    ) -> rpc::Result<()> {
        let mut execution = session.data.lock().await;
        execution.launching = false;
        execution.launch_error = Some(error.clone());
        execution.sending = false;
        self.finish_locked(&mut execution, run::Status::Failed, reason, None)
            .await?;
        session.changed.notify_waiters();
        session.wake.notify_one();
        let context = failure_context(&execution, error);
        drop(execution);
        if self
            .0
            .diagnostics
            .record("session", "execute", reason, context)
            .await
            .is_err()
        {
            eprintln!("session diagnostic could not be persisted");
        }
        Ok(())
    }

    pub(super) async fn save_run_locked(
        &self,
        execution: &mut super::Execution,
        record: &run::Record,
    ) -> rpc::Result<()> {
        if let Some(error) = &execution.run_storage_unknown {
            return Err(error.clone());
        }
        if let Err(error) = record::save_run(&self.0.events, record).await {
            let error = error.with_data(json!({ "runId": record.run.run_id }));
            if error.code == -32006
                || error
                    .data
                    .as_ref()
                    .and_then(|data| data.get("storageOutcome"))
                    .and_then(Value::as_str)
                    == Some("unknown")
            {
                execution.run_storage_unknown = Some(error.clone());
            }
            execution.fault(error.clone());
            return Err(error);
        }
        Ok(())
    }

    pub(super) async fn finish_locked(
        &self,
        execution: &mut super::Execution,
        status: run::Status,
        reason: &str,
        result: Option<Value>,
    ) -> rpc::Result<()> {
        let Some(active) = execution.active.as_ref() else {
            return Ok(());
        };
        let mut terminal = active.record.clone();
        terminal.finish(status, reason, result);
        self.save_run_locked(execution, &terminal).await?;
        execution.active = None;
        Ok(())
    }

    async fn execution_fault(&self, session: &Session, error: rpc::Error) {
        let mut execution = session.data.lock().await;
        execution.sending = false;
        execution.launching = false;
        execution.fault(error.clone());
        let context = failure_context(&execution, &error);
        let cli = execution.cli.clone();
        drop(execution);
        session.changed.notify_waiters();
        if self
            .0
            .diagnostics
            .record("session", "execute", "execution_storage_failed", context)
            .await
            .is_err()
        {
            eprintln!("session diagnostic could not be persisted");
        }
        if let Some(cli) = cli {
            let result = cli.close().await;
            self.cleanup_result(session, cli.instance_id(), &result)
                .await;
        }
    }

    pub(super) async fn cleanup_result(
        &self,
        session: &Session,
        instance_id: &str,
        result: &rpc::Result<()>,
    ) {
        if let Err(error) = result {
            let mut execution = session.data.lock().await;
            let session_id = execution.record.session_id.clone();
            execution.record.native_cleanup_failed = true;
            execution.fault(error.clone());
            let failed = execution.record.clone();
            if let Err(storage) = record::save_session(&self.0.database, &failed).await {
                execution.fault(storage.with_data(json!({ "stage": "native_cleanup_write" })));
            }
            drop(execution);
            if self.0.diagnostics.record("session", "close", "native_cleanup_failed", json!({ "sessionId": session_id, "instanceId": instance_id, "causeCode": error.code })).await.is_err() { eprintln!("session cleanup diagnostic could not be persisted"); }
        }
    }

    pub(super) async fn close_execution(
        &self,
        session: Arc<Session>,
        permanent: bool,
    ) -> rpc::Result<()> {
        let _closing = session.close_guard.lock().await;
        let mut failures = Vec::new();
        {
            let mut execution = session.data.lock().await;
            if execution.record.status == record::Status::Deleting {
                if permanent {
                    execution.record.mutable()?;
                }
                session.stopped.cancel();
                session.wake.notify_one();
                drop(execution);
                if let Some(task) = session.executor.lock().await.take() {
                    task.await.map_err(|error| {
                        rpc::Error::internal("session_executor_task").with_source(error)
                    })?;
                }
                return Ok(());
            }
            if execution.record.native_cleanup_failed {
                failures.push(
                    execution
                        .storage_fault
                        .clone()
                        .unwrap_or_else(|| {
                            rpc::Error::conflict(
                                "native_cleanup_unconfirmed",
                                "The previous CLI instance cleanup was not confirmed",
                            )
                        })
                        .with_data(json!({ "cleanupComplete": false })),
                );
            }
            execution.closing = true;
            if permanent {
                let mut closed = execution.record.clone();
                closed.status = record::Status::Closed;
                closed.updated_at_ms = rpc::now_ms();
                match record::save_session(&self.0.database, &closed).await {
                    Ok(()) => execution.record = closed,
                    Err(error) => {
                        execution.fault(error.clone());
                        failures.push(error.with_data(json!({ "stage": "session_close_write" })));
                    }
                }
            }
            let mut index = 0;
            while let Some(queued) = execution.queue.get(index) {
                let mut terminal = queued.clone();
                terminal.finish(
                    run::Status::Cancelled,
                    if permanent {
                        "session_closed_before_send"
                    } else {
                        "server_shutdown_before_send"
                    },
                    None,
                );
                match self.save_run_locked(&mut execution, &terminal).await {
                    Ok(()) => {
                        execution.queue.remove(index);
                    }
                    Err(error) => {
                        failures.push(error.with_data(json!({ "stage": "queued_terminal_write" })));
                        if execution.run_storage_unknown.is_some() {
                            break;
                        }
                        index += 1;
                    }
                }
            }
        }
        // Keep the consumer live while close joins the bounded CLI reader.
        loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let execution = session.data.lock().await;
            let cli = execution.cli.clone();
            let pending = execution.sending || execution.launching;
            drop(execution);
            if let Some(cli) = cli {
                let closed = cli.close().await;
                self.cleanup_result(&session, cli.instance_id(), &closed)
                    .await;
                if let Err(error) = closed {
                    failures.push(error.with_data(json!({ "stage": "native_close" })));
                }
            }
            if !pending {
                break;
            }
            changed.await;
        }
        if let Some(task) = session.consumer.lock().await.take()
            && let Err(error) = task.await
        {
            failures.push(rpc::Error::internal("session_consumer_task").with_source(error));
        }
        {
            let mut execution = session.data.lock().await;
            if execution.active.is_some()
                && let Err(error) = self
                    .finish_locked(
                        &mut execution,
                        run::Status::OutcomeUnknown,
                        "native_closed_without_terminal",
                        None,
                    )
                    .await
            {
                execution.fault(error.clone());
                failures.push(error.with_data(json!({ "stage": "active_terminal_write" })));
            }
            execution.cli = None;
            execution.native.busy = false;
            execution.native.proactive = native::Proactive::Unobserved;
            execution.consuming = false;
            execution.closing = false;
            execution.idle = super::idle::Idle::Dormant;
            if execution.record.native_cleanup_failed && failures.is_empty() {
                failures.push(
                    execution
                        .storage_fault
                        .clone()
                        .unwrap_or_else(|| {
                            rpc::Error::conflict(
                                "native_cleanup_unconfirmed",
                                "The previous CLI instance cleanup was not confirmed",
                            )
                        })
                        .with_data(json!({ "cleanupComplete": false })),
                );
            }
        }
        session.wake.notify_one();
        if self.0.shutdown.load(Ordering::Acquire)
            && let Some(task) = session.executor.lock().await.take()
            && let Err(error) = task.await
        {
            failures.push(rpc::Error::internal("session_executor_task").with_source(error));
        }
        combined(failures)
    }
}

pub(super) fn failure_context(execution: &super::Execution, error: &rpc::Error) -> Value {
    let mut context = json!({
        "sessionId": execution.record.session_id, "agentId": execution.record.agent_id,
        "causeCode": error.code,
    });
    if let Some(data) = error.data.as_ref().and_then(Value::as_object) {
        if let Some(kind) = data.get("kind").filter(|value| value.is_string()) {
            context["causeKind"] = kind.clone();
        }
        for key in [
            "instanceId",
            "nativeRequestId",
            "stage",
            "phase",
            "ioKind",
            "osCode",
            "delivery",
            "cleanupComplete",
        ] {
            if let Some(value) = data.get(key) {
                context[key] = value.clone();
            }
        }
        if !data.contains_key("stage")
            && let Some(reason) = data.get("reason").and_then(Value::as_str)
            && matches!(
                reason,
                "closing" | "stdout_eof" | "exit" | "output_fault" | "output_closed"
            )
        {
            context["stage"] = reason.into();
        }
    }
    context
}
