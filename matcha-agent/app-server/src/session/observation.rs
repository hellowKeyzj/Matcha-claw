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
        let mut titles = tokio::task::JoinSet::new();
        loop {
            let first = tokio::select! {
                event = receiver.recv() => match event {
                    Some(event) => event,
                    None => break,
                },
                result = titles.join_next(), if !titles.is_empty() => {
                    if result.as_ref().is_some_and(|result| result.is_err()) {
                        eprintln!("session title task failed");
                    }
                    let mut execution = session.data.lock().await;
                    if let Some(Ok(Some(run_id))) = result
                        && let Some(active) = execution.active.as_mut().filter(|active|
                            active.record.run.run_id == run_id)
                    {
                        active.auxiliary_pending -= 1;
                        session.changed.notify_waiters();
                    }
                    if let Some(active) = execution.active.as_ref().filter(|active|
                        active.idle_observed && active.auxiliary_pending == 0 && !active.budget_expired)
                    {
                        let (status, reason) = active.outcome();
                        let result = active.owned_result();
                        if let Err(error) = self.finish_locked(&mut execution, status, reason, result).await {
                            execution.fault(error);
                        }
                        session.changed.notify_waiters();
                        session.wake.notify_one();
                    }
                    continue;
                }
            };
            let mut batch = vec![first];
            // Coalesce an available stdio burst, without a per-token Run write.
            while batch.len() < 256 {
                match receiver.try_recv() {
                    Ok(event) => batch.push(event),
                    Err(_) => break,
                }
            }
            if let Err(error) = self
                .observe_batch(&session, &instance_id, batch, &mut exited, &mut titles)
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
        while let Some(result) = titles.join_next().await {
            if result.is_err() {
                eprintln!("session title task failed");
            }
            if let Ok(Some(run_id)) = result {
                let mut execution = session.data.lock().await;
                if let Some(active) = execution.active.as_mut().filter(|active|
                    active.record.run.run_id == run_id)
                {
                    active.auxiliary_pending -= 1;
                }
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
                if execution
                    .active
                    .as_ref()
                    .is_some_and(|active| !active.budget_expired)
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
        session: &Arc<Session>,
        instance_id: &str,
        batch: Vec<CliEvent>,
        exited: &mut bool,
        titles: &mut tokio::task::JoinSet<Option<String>>,
    ) -> rpc::Result<()> {
        let tracing = std::env::var("MATCHACLAW_TRACE").as_deref() == Ok("1");
        let started = tracing.then(std::time::Instant::now);
        let observed_at_ms = tracing.then(rpc::now_ms);
        let mut timing_stages: Vec<_> = if tracing {
            batch.iter().filter_map(|event| match event {
                CliEvent::Message(message) | CliEvent::Result(message) => {
                    crate::diagnostics::Diagnostics::session_stage(message)
                }
                _ => None,
            }).collect()
        } else { Vec::new() };
        timing_stages.sort_unstable();
        timing_stages.dedup();
        let mut execution = session.data.lock().await;
        let lock_wait_ms = started.map(|started| started.elapsed().as_millis() as u64);
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
                    execution
                        .cli
                        .as_ref()
                        .expect("observed CLI instance")
                        .iab_observe(&message)?;
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
                        let tool_parent_observed =
                            message.get("parent_tool_use_id").is_none_or(|id| {
                                id.is_null()
                                    || id
                                        .as_str()
                                        .is_some_and(|id| active.tool_use_ids.contains(id))
                            });
                        if active.input_started
                            && active.acknowledged
                            && tool_parent_observed
                            && message["type"] == "assistant"
                            && let Some(blocks) = message
                                .pointer("/message/content")
                                .and_then(Value::as_array)
                        {
                            active.tool_use_ids.extend(
                                blocks
                                    .iter()
                                    .filter(|block| block["type"] == "tool_use")
                                    .filter_map(|block| block["id"].as_str().filter(|id| !id.is_empty()))
                                    .map(str::to_owned),
                            );
                        }
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
                            } else if !interrupted
                                && !tool_result(&message)
                                && !(tool_parent_observed
                                    && message
                                        .get("source_tool_use_id")
                                        .and_then(Value::as_str)
                                        .is_some_and(|id| active.tool_use_ids.contains(id)))
                            {
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
                            active.idle_observed = true;
                            let (status, reason) = active.outcome();
                            let result = active.owned_result();
                            if active.auxiliary_pending == 0 {
                                terminal = Some((status, reason, result));
                            }
                        }
                    }
                    if !execution.closing
                        && execution.active.as_ref().is_some_and(|active| {
                            active.input_started
                                && message["type"] == "user"
                                && message["uuid"].as_str()
                                    == Some(active.record.run.message_id.as_str())
                        })
                    {
                        match self.accept_title_locked(&mut execution, &message).await {
                            Ok(Some(description)) => {
                                let scope = execution.active.as_ref().and_then(|active|
                                    active.record.run.world_investigation.as_ref().map(|world| world.frame(&active.record.run))).transpose()?;
                                let run_id = if scope.is_some() {
                                    let active = execution.active.as_mut().expect("acknowledged active Run");
                                    active.auxiliary_pending += 1;
                                    Some(active.record.run.run_id.clone())
                                } else { None };
                                let owner = self.clone();
                                let session = session.clone();
                                let instance = instance_id.to_owned();
                                titles.spawn(async move {
                                    owner.generate_title(session, instance, description, scope).await;
                                    run_id
                                });
                            }
                            Ok(None) => {}
                            Err(error) => {
                                self.title_failure(&execution.record, instance_id, &error)
                                    .await;
                            }
                        }
                    }
                    items.push(("native.message".to_owned(), message));
                }
                CliEvent::Result(result) => {
                    execution
                        .cli
                        .as_ref()
                        .expect("observed CLI instance")
                        .iab_observe(&result)?;
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
                        if !active.input_started
                            || active.result_count > 1
                            || result.get("input_message_id").is_some_and(|id| {
                                id.as_str() != Some(active.record.run.message_id.as_str())
                            })
                            || (active.record.run.request_id.is_some()
                                && result.get("input_message_id").and_then(Value::as_str)
                                    != Some(active.record.run.message_id.as_str()))
                        {
                            active.ownership_ambiguous = true;
                        }
                        active.result = Some(result.clone());
                    }
                    // Input identity does not replace ACK/unique-result/drained-idle ownership.
                    // Retain the session fact now; the Run link is settled only at idle.
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
                    if matches!(request.get("subtype").and_then(Value::as_str),
                        Some("native_io_admit" | "native_io_observe"))
                    {
                        let outcome = self.investigation_control_locked(&mut execution, instance_id, &request).await;
                        let cli = execution.cli.clone().expect("observed CLI instance");
                        let response = match outcome {
                            Ok(response) => json!({"subtype":"success","response":response}),
                            Err(error) => json!({"subtype":"error","error":error.data.as_ref().and_then(|data| data.get("kind")).and_then(Value::as_str).unwrap_or("investigation_io_outcome_unknown")}),
                        };
                        drop(execution);
                        cli.respond(&request_id, response).await?;
                        execution = session.data.lock().await;
                        continue;
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
            if execution.active.as_ref().is_some_and(|active| {
                active.budget_expired
                    || active
                        .deadline
                        .is_some_and(|deadline| deadline <= tokio::time::Instant::now())
            }) {
                terminal = None;
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
                session.changed.notify_waiters();
                session.wake.notify_one();
            }
        }
        if !items.is_empty() {
            self.0.events.append_batch(&session_id, None, items).await?;
        }
        execution.idle.activity();
        session.wake.notify_one();
        drop(execution);
        if let Some(started) = started {
            let elapsed_ms = started.elapsed().as_millis() as u64;
            for stage in timing_stages {
                self.0.diagnostics.trace("session", "timing", "observation_applied", json!({
                    "stage": stage, "observedAtMs": observed_at_ms,
                    "lockWaitMs": lock_wait_ms, "elapsedMs": elapsed_ms,
                    "sessionHash": crate::diagnostics::Diagnostics::identifier_hash(&session_id),
                    "instanceHash": crate::diagnostics::Diagnostics::identifier_hash(instance_id),
                })).await;
            }
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
