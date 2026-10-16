use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{cli::CliEvent, rpc};

use super::{Session, Sessions, native, record, run};

impl Sessions {
    pub(super) async fn consume(
        &self,
        session: Arc<Session>,
        instance_id: String,
        mut receiver: mpsc::Receiver<CliEvent>,
    ) {
        let mut failure = None;
        let mut closer = None;
        let mut exited = false;
        let cli = session.data.lock().await.cli.clone();
        while let Some(first) = receiver.recv().await {
            let mut batch = vec![first];
            // Coalesce an available stdio burst, without a per-token Run write.
            while batch.len() < 256 {
                match receiver.try_recv() {
                    Ok(event) => batch.push(event),
                    Err(_) => break,
                }
            }
            if let Err(error) = self
                .observe_batch(&session, &instance_id, batch, &mut exited)
                .await
            {
                if failure.is_none() {
                    let context = {
                        let execution = session.data.lock().await;
                        super::execution::failure_context(&execution, &error)
                    };
                    if self
                        .0
                        .diagnostics
                        .record("session", "observe", "native_observation_failed", context)
                        .await
                        .is_err()
                    {
                        eprintln!("session observation diagnostic could not be persisted");
                    }
                    failure = Some(error);
                }
                // The reader must remain drained until its bounded sender closes.
                if closer.is_none()
                    && let Some(cli) = cli.clone()
                {
                    closer = Some(tokio::spawn(async move { cli.close().await }));
                }
            }
        }
        let closed = if let Some(task) = closer {
            task.await
                .unwrap_or_else(|_| Err(rpc::Error::internal("session_closer_task")))
        } else if let Some(cli) = &cli {
            cli.close().await
        } else {
            Ok(())
        };
        if let Err(error) = &closed {
            if let Some(primary) = failure.take() {
                failure = Some(primary.with_data(json!({ "cleanupFailure": error })));
            } else {
                failure = Some(error.clone());
            }
        }
        let session_id;
        {
            let mut execution = session.data.lock().await;
            session_id = execution.record.session_id.clone();
            if let Some(error) = failure {
                execution.fault(error);
            }
            if execution
                .cli
                .as_ref()
                .is_some_and(|cli| cli.instance_id() == instance_id)
            {
                if execution.active.is_some()
                    && let Err(error) = self
                        .finish_locked(
                            &mut execution,
                            run::Status::OutcomeUnknown,
                            if exited {
                                "native_exit_without_terminal"
                            } else {
                                "native_stream_ended"
                            },
                            None,
                        )
                        .await
                {
                    execution.fault(error);
                }
                execution.cli = None;
                execution.native.busy = false;
                execution.native.proactive = native::Proactive::Unobserved;
            }
        }
        if let Some(cli) = &cli {
            self.cleanup_result(&session, cli.instance_id(), &closed)
                .await;
        }
        if let Err(error) = self
            .0
            .interactions
            .close_instance(&session_id, &instance_id)
            .await
        {
            session.data.lock().await.fault(error);
        }
        session.data.lock().await.consuming = false;
        session.changed.notify_waiters();
        session.wake.notify_one();
    }

    async fn observe_batch(
        &self,
        session: &Session,
        instance_id: &str,
        batch: Vec<CliEvent>,
        exited: &mut bool,
    ) -> rpc::Result<()> {
        let mut execution = session.data.lock().await;
        if !execution
            .cli
            .as_ref()
            .is_some_and(|cli| cli.instance_id() == instance_id)
        {
            return Ok(());
        }
        let session_id = execution.record.session_id.clone();
        let mut items = Vec::new();
        for event in batch {
            let mut terminal = None;
            match event {
                CliEvent::Message(message) => {
                    if let Some(observed_id) = message.get("session_id").and_then(Value::as_str)
                        && observed_id != session_id
                    {
                        return Err(rpc::Error::new(
                            -32004,
                            "native_session_mismatch",
                            "CLI emitted a different native session identity",
                        ));
                    }
                    execution.native.observe(&message);
                    if let Some(active) = execution.active.as_mut() {
                        let interrupted = native::interrupted(&message);
                        if active.input_started
                            && message.get("type").and_then(Value::as_str) == Some("system")
                            && message.get("subtype").and_then(Value::as_str)
                                == Some("session_state_changed")
                            && matches!(
                                message.get("state").and_then(Value::as_str),
                                Some("running" | "requires_action")
                            )
                        {
                            active.native_cycle_observed = true;
                        }
                        if message.get("type").and_then(Value::as_str) == Some("user") {
                            if message.get("uuid").and_then(Value::as_str)
                                == Some(active.record.run.message_id.as_str())
                            {
                                active.acknowledged = true;
                            } else if !interrupted && !tool_result(&message) {
                                active.ownership_ambiguous = true;
                            }
                        }
                        if message.get("type").and_then(Value::as_str) == Some("system")
                            && message.get("subtype").and_then(Value::as_str)
                                == Some("task_notification")
                        {
                            active.ownership_ambiguous = true;
                        }
                        if interrupted {
                            active.interrupt_observed = true;
                        }
                        if native::idle(&message)
                            && active.input_started
                            && (active.acknowledged || active.native_cycle_observed)
                        {
                            let (status, reason) = active.outcome();
                            let result = active.owned_result();
                            terminal = Some((status, reason, result));
                        }
                    }
                    items.push(("native.message".to_owned(), message));
                }
                CliEvent::Result(result) => {
                    if result.get("session_id").and_then(Value::as_str) != Some(session_id.as_str())
                    {
                        return Err(rpc::Error::new(
                            -32004,
                            "native_result_session_mismatch",
                            "CLI result has an unexpected session identity",
                        ));
                    }
                    if let Some(active) = execution.active.as_mut() {
                        active.result_count += 1;
                        if !active.input_started || active.result_count > 1 {
                            active.ownership_ambiguous = true;
                        }
                        active.result = Some(result.clone());
                    }
                    // Result has no input UUID. Its ownership is known only at drained idle;
                    // retain the session fact now, never an irreversible guessed Run link.
                    items.push(("native.result".to_owned(), result));
                }
                CliEvent::Request {
                    request_id,
                    request,
                } => {
                    if !items.is_empty() {
                        self.0
                            .events
                            .append_batch(&session_id, None, std::mem::take(&mut items))
                            .await?;
                    }
                    let run_id = execution
                        .active
                        .as_ref()
                        .filter(|active| active.acknowledged && !active.ownership_ambiguous)
                        .map(|active| active.record.run.run_id.clone());
                    drop(execution);
                    self.0
                        .interactions
                        .observe(
                            &session_id,
                            run_id.as_deref(),
                            instance_id,
                            &request_id,
                            request,
                        )
                        .await?;
                    execution = session.data.lock().await;
                }
                CliEvent::Cancel { request_id } => {
                    if !items.is_empty() {
                        self.0
                            .events
                            .append_batch(&session_id, None, std::mem::take(&mut items))
                            .await?;
                    }
                    drop(execution);
                    self.0
                        .interactions
                        .cancel(&session_id, instance_id, &request_id)
                        .await?;
                    execution = session.data.lock().await;
                }
                CliEvent::Exited { code, signal } => {
                    *exited = true;
                    items.push((
                        "cli.exited".to_owned(),
                        json!({ "instanceId": instance_id, "code": code, "signal": signal }),
                    ));
                    if execution.active.is_some() {
                        terminal = Some((
                            run::Status::OutcomeUnknown,
                            "native_exit_without_terminal",
                            None,
                        ));
                    }
                }
                CliEvent::Fault(error) => {
                    items.push(("cli.fault".to_owned(), json!({ "instanceId": instance_id, "code": error.code, "kind": error.data.as_ref().and_then(|data| data.get("kind")) })));
                    if execution.active.is_some() {
                        terminal =
                            Some((run::Status::OutcomeUnknown, "native_protocol_fault", None));
                    }
                }
            }
            if !execution.record.native_started
                && execution
                    .active
                    .as_ref()
                    .is_some_and(|active| active.acknowledged)
            {
                let mut started = execution.record.clone();
                started.native_started = true;
                started.updated_at_ms = rpc::now_ms();
                record::save_session(&self.0.database, &started).await?;
                execution.record = started;
            }
            if let Some((status, reason, result)) = terminal {
                if !items.is_empty() {
                    self.0
                        .events
                        .append_batch(&session_id, None, std::mem::take(&mut items))
                        .await?;
                }
                self.finish_locked(&mut execution, status, reason, result)
                    .await?;
                session.wake.notify_one();
            }
        }
        if !items.is_empty() {
            self.0.events.append_batch(&session_id, None, items).await?;
        }
        Ok(())
    }
}

fn tool_result(message: &Value) -> bool {
    message
        .pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            !blocks.is_empty()
                && blocks
                    .iter()
                    .all(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
}
